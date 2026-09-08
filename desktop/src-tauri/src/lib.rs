mod control_config;
#[path = "../control_config.rs"]
mod control_config_validation;
mod downloads;
mod install_path;
mod install_storage;
mod node_isolation;
mod runtime_control;
mod tray;
mod uninstall;
mod updates;
use install_path::validate_install_dir;
use node_isolation::{configure as configure_node, Phase};

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const REGISTRY: &str = "https://registry.npmmirror.com";
const RECEIPT_FILE: &str = "neo-desktop-runtime.json";

#[derive(Default)]
struct DesktopState {
    child: Arc<Mutex<Option<Child>>>,
    runtime_url: Mutex<Option<(PathBuf, String)>>,
    start_url: Mutex<Option<tauri::Url>>,
    manual_start: std::sync::atomic::AtomicBool,
    operation: Mutex<()>,
}

#[derive(Serialize)]
struct BootstrapState {
    default_install_dir: String,
    installed: bool,
    auto_launch: bool,
    install_dir: Option<String>,
    web_version: Option<String>,
    core_version: Option<String>,
}

#[derive(Serialize, Clone)]
struct RuntimeVersions {
    web_version: String,
    core_version: String,
    core_requirement: Option<String>,
}

#[derive(Clone, Copy)]
enum RuntimeSource {
    Bundled,
    RegistryLatestInstall,
    RegistryLatest,
}

impl RuntimeSource {
    fn web_specifier(self) -> &'static str {
        match self {
            Self::Bundled => "file:packages/neoctl-web.tgz",
            Self::RegistryLatestInstall | Self::RegistryLatest => "latest",
        }
    }

    fn is_update(self) -> bool {
        matches!(self, Self::RegistryLatest)
    }

    fn label(self) -> &'static str {
        match self {
            Self::Bundled => "bundled",
            Self::RegistryLatestInstall | Self::RegistryLatest => "registry-latest",
        }
    }
}

#[derive(Serialize, Clone)]
struct InstallProgress {
    percent: u8,
    title: String,
    message: String,
    stage: String,
    log: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_dir: Option<String>,
}

#[derive(Serialize, Clone)]
struct RuntimeLog {
    line: String,
}

#[derive(Serialize, Deserialize)]
struct DesktopConfig {
    install_dir: String,
}

#[derive(Serialize, Deserialize)]
struct InstallReceipt {
    schema: u8,
    web_package: String,
    installed_at: String,
    registry: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    core_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    core_requirement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[tauri::command]
fn sync_window_theme(window: WebviewWindow, theme: String) -> Result<(), String> {
    let theme = match theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    };
    window.set_theme(theme).map_err(|error| error.to_string())
}

#[tauri::command]
fn bootstrap_state(app: AppHandle) -> Result<BootstrapState, String> {
    let configured =
        read_optional_desktop_config(&app)?.map(|value| PathBuf::from(value.install_dir));
    // A configured but inaccessible/incomplete runtime is not a fresh install.
    let default_dir = match &configured {
        Some(path) => path.clone(),
        None => default_install_dir()?,
    };
    let install_dir = configured;
    let versions = install_dir
        .as_deref()
        .and_then(|path| read_runtime_versions(&path.join("runtime")).ok());
    Ok(BootstrapState {
        default_install_dir: default_dir.to_string_lossy().into_owned(),
        installed: install_dir
            .as_deref()
            .map(runtime_is_installed)
            .unwrap_or(false),
        auto_launch: install_dir
            .as_deref()
            .map(runtime_is_installed)
            .unwrap_or(false)
            && !app
                .state::<DesktopState>()
                .manual_start
                .load(std::sync::atomic::Ordering::Acquire),
        install_dir: install_dir.map(|path| path.to_string_lossy().into_owned()),
        web_version: versions.as_ref().map(|value| value.web_version.clone()),
        core_version: versions.map(|value| value.core_version),
    })
}

#[tauri::command]
async fn choose_install_directory(initial: String) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("选择 Neo Desktop 数据位置");
    let candidate = PathBuf::from(initial.trim());
    if candidate.exists() {
        dialog = dialog.set_directory(candidate);
    }
    Ok(dialog
        .pick_folder()
        .await
        .map(|handle| handle.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn install_runtime(app: AppHandle, install_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_runtime_blocking(
            &app,
            PathBuf::from(install_dir),
            RuntimeSource::RegistryLatestInstall,
        )
        .map(|_| ())
    })
    .await
    .map_err(|error| format!("安装任务异常结束：{error}"))?
}

#[tauri::command]
async fn update_runtime(app: AppHandle) -> Result<RuntimeVersions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = read_desktop_config(&app)?;
        install_runtime_blocking(
            &app,
            PathBuf::from(config.install_dir),
            RuntimeSource::RegistryLatest,
        )
    })
    .await
    .map_err(|error| format!("更新任务异常结束：{error}"))?
}

#[tauri::command]
async fn launch_runtime(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    install_dir: String,
) -> Result<(), String> {
    let child_slot = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || {
        launch_runtime_blocking(&app, &window, child_slot, PathBuf::from(install_dir), true)
    })
    .await
    .map_err(|error| format!("启动任务异常结束：{error}"))?
}

fn install_runtime_blocking(
    app: &AppHandle,
    install_dir: PathBuf,
    source: RuntimeSource,
) -> Result<RuntimeVersions, String> {
    let state = app.state::<DesktopState>();
    let _operation = state.operation.lock().map_err(|_| "操作锁错误")?;
    if runtime_control::runtime_status(app.clone()) {
        return Err(if source.is_update() {
            "请先关闭核心和后台再更新".into()
        } else {
            "请先关闭核心和后台再安装".into()
        });
    }
    validate_install_dir(&install_dir)?;
    let updating = source.is_update();
    let configured = read_optional_desktop_config(app)?;
    if let Some(config) = &configured {
        if !install_storage::same_path(Path::new(&config.install_dir), &install_dir) {
            return Err("已有安装配置，请使用原目录；迁移需手动完成。".into());
        }
    }
    // Fail before downloading when the stable config pointer cannot be saved.
    preflight_desktop_config(app)?;
    let requested = install_dir;
    let mut probe_failures = Vec::new();
    let install_dir = install_storage::select(
        &requested,
        &install_storage::candidates(),
        updating || configured.is_some(),
        validate_install_dir,
        |path| {
            let result = install_storage::probe(path);
            if let Err(reason) = &result {
                probe_failures.push(reason.clone());
            }
            result
        },
    )
    .map_err(|detail| {
        let message = if updating || configured.is_some() || detail.contains("不会自动切换") {
            "原目录不可用，请检查权限；未更换目录。"
        } else {
            "目录不可用，请检查权限或另选专用目录。"
        };
        emit_progress(app, 2, "目录检查失败", message, "初始化", Some(detail));
        message.to_string()
    })?;
    let changed = !install_storage::same_path(&requested, &install_dir);
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            percent: 2,
            title: if changed {
                "已自动更换目录"
            } else {
                "准备运行环境"
            }
            .into(),
            message: install_dir.to_string_lossy().into_owned(),
            stage: "初始化".into(),
            log: changed.then(|| probe_failures.join("\n")),
            install_dir: Some(install_dir.to_string_lossy().into_owned()),
        },
    );

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源：{error}"))?;
    let node_source = resource_dir.join("node");
    let payload_source = resource_dir.join("payload").join("neoctl-web.tgz");
    if !node_source.join("node.exe").exists() {
        return Err(format!("内置 Node 运行时缺失：{}", node_source.display()));
    }
    if matches!(source, RuntimeSource::Bundled) && !payload_source.exists() {
        return Err(format!("内置 npm 软件包缺失：{}", payload_source.display()));
    }

    let staging = install_dir.join(".runtime-staging");
    let runtime = install_dir.join("runtime");
    remove_dir_if_exists(&staging)?;
    fs::create_dir_all(staging.join("packages")).map_err(display_io("无法创建临时目录"))?;

    let web_specifier = source.web_specifier();
    let package_json = serde_json::json!({
        "name": "neoctl-desktop-runtime",
        "version": "1.0.0",
        "private": true,
        "dependencies": {
            "neoctl-web": web_specifier
        }
    });
    fs::write(
        staging.join("package.json"),
        serde_json::to_vec_pretty(&package_json).map_err(|error| error.to_string())?,
    )
    .map_err(display_io("无法写入运行时 package.json"))?;

    emit_progress(
        app,
        8,
        "释放基础组件",
        "正在复制内置 Node.js 与 npm…",
        "复制运行时",
        None,
    );
    copy_dir_recursive(&node_source, &staging.join("node"))?;
    if matches!(source, RuntimeSource::Bundled) {
        fs::copy(
            &payload_source,
            staging.join("packages").join("neoctl-web.tgz"),
        )
        .map_err(display_io("无法释放 neoctl-web 软件包"))?;
    }

    emit_progress(
        app,
        15,
        if updating {
            "更新 Web 与 Core"
        } else {
            "安装应用依赖"
        },
        if matches!(source, RuntimeSource::Bundled) {
            "正在通过国内镜像获取 Core 与依赖…"
        } else {
            "正在通过国内镜像获取最新 Web 与其兼容的 Core…"
        },
        "连接软件源",
        Some(format!("registry: {REGISTRY}")),
    );
    run_npm_install(app, &install_dir, &staging)?;

    let server_entry = staging
        .join("node_modules")
        .join("neoctl-web")
        .join("server.mjs");
    if !server_entry.exists() {
        return Err(format!(
            "安装完成但未找到服务入口：{}",
            server_entry.display()
        ));
    }

    emit_progress(
        app,
        90,
        "校验安装结果",
        "正在检查 Web 与 Core 版本…",
        "完整性检查",
        None,
    );
    let versions = read_runtime_versions(&staging)?;
    let receipt = InstallReceipt {
        schema: 1,
        web_package: format!("neoctl-web@{}", versions.web_version),
        installed_at: unix_timestamp().to_string(),
        registry: REGISTRY.to_string(),
        web_version: Some(versions.web_version.clone()),
        core_version: Some(versions.core_version.clone()),
        core_requirement: versions.core_requirement.clone(),
        source: Some(source.label().to_string()),
    };
    fs::write(
        staging.join(RECEIPT_FILE),
        serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?,
    )
    .map_err(display_io("无法写入安装记录"))?;

    let backup = install_dir.join(".runtime-previous");
    remove_dir_if_exists(&backup)?;
    if runtime.exists() {
        fs::rename(&runtime, &backup).map_err(display_io("无法备份已有运行时"))?;
    }
    if let Err(error) = fs::rename(&staging, &runtime) {
        if backup.exists() {
            let _ = fs::rename(&backup, &runtime);
        }
        return Err(format!("无法启用新运行时：{error}"));
    }
    remove_dir_if_exists(&backup)?;
    fs::create_dir_all(install_dir.join("data").join("workspaces"))
        .map_err(display_io("无法创建数据目录"))?;
    write_desktop_config(app, &install_dir)?;
    emit_progress(
        app,
        100,
        if updating {
            "更新完成"
        } else {
            "安装完成"
        },
        &format!(
            "Web {} / Core {} 已准备完成。",
            versions.web_version, versions.core_version
        ),
        "完成",
        None,
    );
    Ok(versions)
}

fn run_npm_install(app: &AppHandle, root: &Path, staging: &Path) -> Result<(), String> {
    let node = staging.join("node").join("node.exe");
    let npm_cli = staging
        .join("node")
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    if !npm_cli.exists() {
        return Err(format!("内置 npm CLI 缺失：{}", npm_cli.display()));
    }
    let mut command = Command::new(node);
    configure_node(&mut command, root, staging, staging, Phase::Install)?;
    command
        .arg(npm_cli)
        .args([
            "install",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "--foreground-scripts",
            "--install-strategy=nested",
            "--loglevel=http",
            "--registry",
            REGISTRY,
        ])
        .current_dir(staging)
        .env("npm_config_registry", REGISTRY)
        .env("npm_config_progress", "true")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 npm：{error}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 npm 标准输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 npm 错误输出")?;
    let app_for_stdout = app.clone();
    let out_thread = thread::spawn(move || stream_install_output(app_for_stdout, stdout, false));
    let app_for_stderr = app.clone();
    let err_thread = thread::spawn(move || stream_install_output(app_for_stderr, stderr, true));
    let status = child
        .wait()
        .map_err(|error| format!("等待 npm 结束失败：{error}"))?;
    let _ = out_thread.join();
    let _ = err_thread.join();
    if !status.success() {
        return Err(format!(
            "npm install 失败，退出码：{}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

fn stream_install_output<R: Read>(app: AppHandle, reader: R, is_error: bool) {
    let mut count = 0u16;
    for line in BufReader::new(reader).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        count = count.saturating_add(1);
        let percent = (18 + count / 3).min(84) as u8;
        let stage = if trimmed.contains("fetch") || trimmed.contains("GET 200") {
            "下载依赖"
        } else if trimmed.contains("added") || trimmed.contains("changed") {
            "整理依赖"
        } else if is_error {
            "安装输出"
        } else {
            "解析依赖"
        };
        emit_progress(
            &app,
            percent,
            "安装应用依赖",
            "正在安装 core 与前后端运行依赖…",
            stage,
            Some(trimmed.to_string()),
        );
    }
}

fn launch_runtime_blocking(
    app: &AppHandle,
    window: &WebviewWindow,
    child_slot: Arc<Mutex<Option<Child>>>,
    install_dir: PathBuf,
    navigate: bool,
) -> Result<(), String> {
    let desktop_lock = app.state::<DesktopState>();
    let _operation = desktop_lock.operation.lock().map_err(|_| "操作锁错误")?;
    validate_install_dir(&install_dir)?;
    if !runtime_is_installed(&install_dir) {
        return Err("所选位置没有完整的 Neo Desktop 运行时，请先安装。".to_string());
    }
    let desktop = app.state::<DesktopState>();
    let running = desktop
        .runtime_url
        .lock()
        .map_err(|_| "状态锁错误")?
        .clone();
    if let Some((root, url)) = running {
        let alive = child_slot
            .lock()
            .map_err(|_| "状态锁错误")?
            .as_mut()
            .map(|c| matches!(c.try_wait(), Ok(None)))
            .unwrap_or(false);
        if alive && root == install_dir {
            if navigate {
                return window
                    .navigate(url.parse().map_err(|e| format!("{e}"))?)
                    .map_err(|e| e.to_string());
            }
            return Ok(());
        }
    }
    stop_existing_child(&child_slot);
    *desktop.runtime_url.lock().map_err(|_| "状态锁错误")? = None;
    let web_port = available_port()?;
    let runtime_port = available_port_excluding(web_port)?;
    let runtime = install_dir.join("runtime");
    let node = runtime.join("node").join("node.exe");
    let server = runtime
        .join("node_modules")
        .join("neoctl-web")
        .join("server.mjs");
    let data_dir = install_dir.join("data");
    let workspace_dir = data_dir.join("workspaces");
    let nested_agent_vendor = runtime
        .join("node_modules")
        .join("neoctl-web")
        .join("node_modules")
        .join("neoctl");
    let agent_vendor = if nested_agent_vendor.exists() {
        nested_agent_vendor
    } else {
        runtime.join("node_modules").join("neoctl")
    };
    let log_dir = install_dir.join("logs");
    fs::create_dir_all(&log_dir).map_err(display_io("无法创建日志目录"))?;

    let mut command = Command::new(node);
    configure_node(
        &mut command,
        &install_dir,
        &runtime,
        &data_dir,
        Phase::Runtime,
    )?;
    command
        .arg(server)
        .current_dir(&data_dir)
        .env("APP_HOST", "127.0.0.1")
        .env("APP_PORT", web_port.to_string())
        .env(
            "NEO_RUNTIME_TARGET",
            format!("http://127.0.0.1:{runtime_port}"),
        )
        .env("NEO_EMBED_RUNTIME", "true")
        .env("NEO_CORE_SOURCE", "package")
        .env("NEO_WEB_DATA_DIR", &data_dir)
        .env("NEO_WORKSPACE_ROOT", &workspace_dir)
        .env("AGENT_VENDOR_DIR", &agent_vendor)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    control_config::configure(&mut command)?;
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Neo 服务：{error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *child_slot.lock().map_err(|_| "运行时状态锁已损坏")? = Some(child);
    if let Some(stream) = stdout {
        stream_runtime_output(app.clone(), stream, log_dir.join("runtime.log"));
    }
    if let Some(stream) = stderr {
        stream_runtime_output(app.clone(), stream, log_dir.join("runtime-error.log"));
    }

    let url = format!("http://127.0.0.1:{web_port}");
    wait_for_http(&url, Duration::from_secs(45))?;
    *app.state::<DesktopState>()
        .runtime_url
        .lock()
        .map_err(|_| "状态锁错误")? = Some((install_dir.clone(), url.clone()));
    write_desktop_config(app, &install_dir)?;
    if !navigate {
        return Ok(());
    }
    window
        .navigate(
            url.parse()
                .map_err(|error| format!("本地地址无效：{error}"))?,
        )
        .map_err(|error| format!("无法进入 Neo 界面：{error}"))?;
    Ok(())
}

fn stream_runtime_output<R: Read + Send + 'static>(app: AppHandle, reader: R, log_path: PathBuf) {
    thread::spawn(move || {
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .ok();
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if let Some(file) = log.as_mut() {
                let _ = writeln!(file, "{line}");
            }
            let _ = app.emit("runtime-log", RuntimeLog { line });
        }
    });
}

fn wait_for_http(base_url: &str, timeout: Duration) -> Result<(), String> {
    let address = base_url.trim_start_matches("http://");
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(address) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = stream.write_all(
                b"GET /api/client-info HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
            let mut response = String::new();
            if stream.read_to_string(&mut response).is_ok() && response.starts_with("HTTP/1.1 200")
            {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(350));
    }
    Err("Neo 本地服务启动超时，请查看安装目录 logs 文件夹。".to_string())
}

fn available_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("无法分配本地端口：{error}"))
}

fn available_port_excluding(excluded: u16) -> Result<u16, String> {
    for _ in 0..8 {
        let port = available_port()?;
        if port != excluded {
            return Ok(port);
        }
    }
    Err("无法为 core 分配独立端口".to_string())
}

fn runtime_is_installed(root: &Path) -> bool {
    root.join("runtime").join(RECEIPT_FILE).exists()
        && root.join("runtime").join("node").join("node.exe").exists()
        && root
            .join("runtime")
            .join("node_modules")
            .join("neoctl-web")
            .join("server.mjs")
            .exists()
}

fn read_runtime_versions(runtime: &Path) -> Result<RuntimeVersions, String> {
    let web_root = runtime.join("node_modules").join("neoctl-web");
    let web_manifest_path = web_root.join("package.json");
    let web_manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(&web_manifest_path).map_err(display_io("无法读取 Web 版本"))?,
    )
    .map_err(|error| format!("Web package.json 格式错误：{error}"))?;
    let web_version = web_manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("Web package.json 缺少版本")?
        .to_string();
    let core_requirement = web_manifest
        .get("dependencies")
        .and_then(|value| value.get("neoctl"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let nested_core = web_root.join("node_modules").join("neoctl");
    let core_root = if nested_core.exists() {
        nested_core
    } else {
        runtime.join("node_modules").join("neoctl")
    };
    let core_manifest_path = core_root.join("package.json");
    let core_manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(&core_manifest_path).map_err(display_io("无法读取 Core 版本"))?,
    )
    .map_err(|error| format!("Core package.json 格式错误：{error}"))?;
    let core_version = core_manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("Core package.json 缺少版本")?
        .to_string();
    let core_entry = core_root.join("dist").join("index.js");
    if !core_entry.exists() {
        return Err(format!(
            "安装完成但未找到 Core 入口：{}",
            core_entry.display()
        ));
    }
    Ok(RuntimeVersions {
        web_version,
        core_version,
        core_requirement,
    })
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(display_io("无法创建目标目录"))?;
    for entry in fs::read_dir(source).map_err(display_io("无法读取内置资源"))? {
        let entry = entry.map_err(display_io("无法读取资源项"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry
            .file_type()
            .map_err(display_io("无法读取资源类型"))?
            .is_dir()
        {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(display_io("无法复制资源文件"))?;
        }
    }
    Ok(())
}

fn default_install_dir() -> Result<PathBuf, String> {
    install_storage::candidates()
        .into_iter()
        .find(|path| validate_install_dir(path).is_ok())
        .ok_or_else(|| "无法确定安全目录，请检查用户目录设置。".into())
}

fn desktop_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法确定桌面壳配置目录：{error}"))?;
    Ok(dir.join("desktop.json"))
}

fn development_runtime_dir() -> Option<PathBuf> {
    std::env::var_os("NEO_DESKTOP_DEV_RUNTIME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn read_optional_desktop_config(app: &AppHandle) -> Result<Option<DesktopConfig>, String> {
    if let Some(install_dir) = development_runtime_dir() {
        return Ok(Some(DesktopConfig {
            install_dir: install_dir.to_string_lossy().into_owned(),
        }));
    }
    read_desktop_config_file(&desktop_config_path(app)?)
}

fn read_desktop_config_file(path: &Path) -> Result<Option<DesktopConfig>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查桌面配置，请检查权限：{error}")),
        Ok(_) => {}
    }
    let content =
        fs::read(&path).map_err(|error| format!("无法读取已有桌面配置，请检查权限：{error}"))?;
    serde_json::from_slice(&content)
        .map(Some)
        .map_err(|error| format!("桌面配置损坏，请修复后重试：{error}"))
}

fn read_desktop_config(app: &AppHandle) -> Result<DesktopConfig, String> {
    read_optional_desktop_config(app)?.ok_or_else(|| "尚未配置安装目录".into())
}

fn preflight_desktop_config(app: &AppHandle) -> Result<(), String> {
    if development_runtime_dir().is_some() {
        return Ok(());
    }
    let path = desktop_config_path(app)?;
    let parent = path.parent().ok_or("无法确定桌面配置目录")?;
    validate_install_dir(parent)?;
    fs::create_dir_all(parent).map_err(display_io("无法创建桌面配置目录，请检查权限"))?;
    // Non-destructive write-open catches an existing read-only pointer too.
    match fs::OpenOptions::new().write(true).open(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("桌面配置不可写，请检查权限：{e}")),
    }
    install_storage::probe(parent).map_err(|e| format!("桌面配置目录不可写，请检查权限：{e}"))
}

fn write_desktop_config(app: &AppHandle, install_dir: &Path) -> Result<(), String> {
    if development_runtime_dir().is_some() {
        return Ok(());
    }
    let value = DesktopConfig {
        install_dir: install_dir.to_string_lossy().into_owned(),
    };
    fs::write(
        desktop_config_path(app)?,
        serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?,
    )
    .map_err(display_io("无法保存桌面壳配置"))
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    const ATTEMPTS: usize = 5;
    for attempt in 0..ATTEMPTS {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) if attempt + 1 < ATTEMPTS => {
                // Antivirus/indexers can briefly hold freshly stopped Node files on Windows.
                // Retrying also finishes a prior remove_dir_all that deleted only part of a tree.
                thread::sleep(Duration::from_millis(150 * (attempt as u64 + 1)));
            }
            Err(error) => return Err(display_io("无法清理旧目录")(error)),
        }
    }
    Ok(())
}

fn emit_progress(
    app: &AppHandle,
    percent: u8,
    title: &str,
    message: &str,
    stage: &str,
    log: Option<String>,
) {
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            percent,
            title: title.to_string(),
            message: message.to_string(),
            stage: stage.to_string(),
            log,
            install_dir: None,
        },
    );
}

fn stop_existing_child(slot: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(child) = guard.as_mut() {
            #[cfg(windows)]
            {
                let mut killer = Command::new("taskkill.exe");
                killer
                    .args(["/pid", &child.id().to_string(), "/t", "/f"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                hide_window(&mut killer);
                let _ = killer.status();
            }
            #[cfg(not(windows))]
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn display_io(context: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{context}：{error}")
}

fn unix_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn run() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            sync_window_theme,
            bootstrap_state,
            choose_install_directory,
            install_runtime,
            update_runtime,
            launch_runtime,
            uninstall::uninstall_desktop,
            updates::check_package_updates,
            runtime_control::runtime_status,
            runtime_control::start_backend,
            runtime_control::stop_backend,
            runtime_control::enter_application
        ])
        .setup(|app| {
            downloads::setup(app)?;
            uninstall::setup_menu(app)?;
            tray::setup(app)?;
            Ok(())
        })
        .on_menu_event(uninstall::on_menu_event)
        .on_window_event(tray::on_window_event)
        .run(tauri::generate_context!())
        .expect("failed to run Neo Desktop");
}

#[cfg(test)]
mod runtime_source_tests {
    use super::RuntimeSource;

    #[test]
    fn first_install_uses_registry_latest_without_update_semantics() {
        let source = RuntimeSource::RegistryLatestInstall;
        assert_eq!(source.web_specifier(), "latest");
        assert_eq!(source.label(), "registry-latest");
        assert!(!source.is_update());
    }

    #[test]
    fn startup_page_update_still_uses_registry_latest() {
        let source = RuntimeSource::RegistryLatest;
        assert_eq!(source.web_specifier(), "latest");
        assert_eq!(source.label(), "registry-latest");
        assert!(source.is_update());
    }

    #[test]
    fn bundled_source_remains_explicit_and_is_not_an_update() {
        let source = RuntimeSource::Bundled;
        assert_eq!(source.web_specifier(), "file:packages/neoctl-web.tgz");
        assert_eq!(source.label(), "bundled");
        assert!(!source.is_update());
    }
}
