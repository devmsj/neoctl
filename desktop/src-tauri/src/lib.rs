mod directory_gate;
mod downloads;
mod health_check;
mod install_path;
mod install_preflight;
mod install_storage;
mod local_resources;
mod local_file_drop;
mod managed_process;
mod node_isolation;
mod runtime_control;
mod runtime_store;
mod tray;
mod uninstall;
mod updates;
use install_path::validate_install_dir;
use managed_process::ManagedChild as Child;
use node_isolation::{configure as configure_node, Phase};

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const REGISTRY: &str = "https://registry.npmjs.org";

#[derive(Default)]
struct DesktopState {
    child: Arc<Mutex<Option<Child>>>,
    runtime_url: Mutex<Option<(PathBuf, String)>>,
    start_url: Mutex<Option<tauri::Url>>,
    manual_start: std::sync::atomic::AtomicBool,
    operation: Mutex<()>,
    owner: Mutex<Option<(PathBuf, fs::File)>>,
}

#[derive(Serialize)]
struct BootstrapState {
    default_install_dir: String,
    installed: bool,
    auto_launch: bool,
    install_dir: Option<String>,
    web_version: Option<String>,
    core_version: Option<String>,
    cleanup_pending: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RuntimeVersions {
    web_version: String,
    core_version: String,
    core_requirement: Option<String>,
    #[serde(default)]
    cleanup_pending: Vec<String>,
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
    if let Some(root) = &install_dir {
        validate_install_dir(root)?;
        runtime_store::current(root)?;
        ensure_owner(&app, root)?;
    }
    let versions = install_dir.as_deref().and_then(|path| {
        runtime_store::current(path)
            .ok()
            .and_then(|p| read_runtime_versions(&p).ok())
    });
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
        cleanup_pending: configured_cleanup_pending(&app)?,
    })
}

fn configured_cleanup_pending(app: &AppHandle) -> Result<bool, String> {
    let Some(config) = read_optional_desktop_config(app)? else {
        return Ok(false);
    };
    Ok(runtime_store::transaction(Path::new(&config.install_dir))?.is_some())
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
fn inspect_install_directory(
    app: AppHandle,
    install_dir: String,
) -> Result<install_preflight::DirectoryState, String> {
    if read_optional_desktop_config(&app)?.is_some() {
        return Err("已有配置，请使用更新；不会清空已有会话目录".into());
    }
    let path = PathBuf::from(install_dir);
    let result = install_preflight::inspect(&path)?;
    if !result.nonempty {
        install_storage::probe(&path)?;
    }
    Ok(result)
}

#[tauri::command]
async fn clear_install_directory(app: AppHandle, install_dir: String) -> Result<bool, String> {
    if read_optional_desktop_config(&app)?.is_some() {
        return Err("已有配置，请使用旧版本清理或更新，不清空会话目录".into());
    }
    let root = PathBuf::from(&install_dir);
    let contents = install_preflight::inspect(&root)?;
    if !contents.nonempty {
        return Ok(true);
    }
    let accepted=rfd::AsyncMessageDialog::new().set_title("清空后重新安装")
        .set_description(format!("将永久删除此目录内的全部内容：\n{}\n\n包括会话、配置、工作区及其他文件，无法恢复。请先备份。\n现有内容：{}\n\n如需保留内容请选择取消并换一个目录。确认清空？",root.display(),contents.entries.iter().take(12).cloned().collect::<Vec<_>>().join("、")))
        .set_buttons(rfd::MessageButtons::OkCancel).show().await==rfd::MessageDialogResult::Ok;
    if !accepted {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let _operation = state.operation.lock().map_err(|_| "操作锁错误")?;
        if read_optional_desktop_config(&app)?.is_some() {
            return Err("安装状态已改变，未清理".into());
        }
        install_preflight::clear_confirmed(&root)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
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
    if runtime_control::runtime_status(app.clone())
        && rfd::AsyncMessageDialog::new()
            .set_title("更新 Web 和 Core")
            .set_description(
                "下载期间后台保持运行。新版本准备完成后将停止后台任务并重启，确认更新？",
            )
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show()
            .await
            != rfd::MessageDialogResult::Ok
    {
        return Err("已取消更新，后台未停止".into());
    }
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
    if !source.is_update() && runtime_control::runtime_status(app.clone()) {
        return Err(if source.is_update() {
            "请先关闭核心和后台再更新".into()
        } else {
            "请先关闭核心和后台再安装".into()
        });
    }
    if !source.is_update()
        && read_optional_desktop_config(app)?.is_none()
        && install_preflight::inspect(&install_dir)?.nonempty
    {
        return Err("所选目录已有内容，请先确认清理或更换目录；未开始安装".into());
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

    ensure_owner(app, &install_dir)?;
    let result = (|| {
        fs::create_dir_all(install_dir.join("data/workspaces"))
            .map_err(display_io("无法创建数据目录"))?;
        write_desktop_config(app, &install_dir)?;
        run_independent_update(app, &install_dir, source)
    })();
    // A failed first install must remain eligible for explicit clear/retry.
    // Keep the durable config when commit already happened, even if reporting failed.
    if result.is_err() && configured.is_none() && runtime_store::current_id(&install_dir)?.is_none()
    {
        let config_path = desktop_config_path(app)?;
        if config_path.exists() {
            fs::remove_file(config_path).map_err(display_io("无法重置首次安装配置"))?;
        }
        *state.owner.lock().map_err(|_| "目录所有者状态锁错误")? = None;
    }
    result
}

fn updater_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
    let bundled = resource.join("updater/neoctl-updater.exe");
    if bundled.is_file() {
        return Ok(bundled);
    }
    let sibling = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("neoctl-updater.exe");
    if cfg!(debug_assertions) && sibling.is_file() {
        return Ok(sibling);
    }
    Err("独立更新器缺失，请重新安装完整桌面版".into())
}

fn run_independent_update(
    app: &AppHandle,
    root: &Path,
    source: RuntimeSource,
) -> Result<RuntimeVersions, String> {
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
    let mut command = Command::new(updater_path(app)?);
    command
        .arg("prepare")
        .arg(root)
        .arg(resource)
        .arg(if matches!(source, RuntimeSource::Bundled) {
            "bundled"
        } else {
            "latest"
        })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut updater = Child::spawn(&mut command).map_err(|e| format!("无法启动独立更新器：{e}"))?;
    let output = updater.stdout.take().ok_or("无法读取更新器输出")?;
    let state = app.state::<DesktopState>();
    let window = app.get_webview_window("main").ok_or("桌面窗口已关闭")?;
    let previous = runtime_store::current(root)?;
    let mut switched = false;
    let mut activated = None;
    let (events, received) = std::sync::mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if events.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(1800);
    let result = (|| -> Result<RuntimeVersions, String> {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = received
                .recv_timeout(remaining)
                .map_err(|e| format!("更新器等待超时或提前退出：{e}；旧版本指针未主动更改"))?
                .map_err(|e| e.to_string())?;
            let event: serde_json::Value =
                serde_json::from_str(&line).map_err(|e| format!("更新器协议错误：{e}"))?;
            match event["event"].as_str().unwrap_or("") {
                "log" => emit_progress(
                    app,
                    40,
                    "准备独立版本",
                    "下载和安装新版本，不覆盖旧文件",
                    "安装依赖",
                    event["message"].as_str().map(str::to_string),
                ),
                "error" => return Err(event["message"].as_str().unwrap_or("更新器失败").into()),
                "ready" => {
                    let id = event["candidate"].as_str().ok_or("候选版本缺失")?;
                    let tx = runtime_store::transaction(root)?.ok_or("更新事务缺失")?;
                    if tx.candidate != id {
                        return Err("候选版本与更新事务不一致".into());
                    }
                    let candidate = runtime_store::release(root, id)?;
                    emit_progress(
                        app,
                        90,
                        "验证新版本",
                        "正在启动候选后台并检查健康状态",
                        "健康检查",
                        None,
                    );
                    switched = true;
                    stop_existing_child(&state.child)?;
                    *state.runtime_url.lock().map_err(|_| "状态锁错误")? = None;
                    launch_version(
                        app,
                        &window,
                        state.child.clone(),
                        root.into(),
                        false,
                        Some(candidate),
                    )?;
                    activated = Some(id.to_string());
                    updater
                        .stdin
                        .as_mut()
                        .ok_or("更新器输入已关闭")?
                        .write_all(b"commit\n")
                        .map_err(|e| e.to_string())?;
                }
                "done" => {
                    let mut versions: RuntimeVersions =
                        serde_json::from_value(event["versions"].clone())
                            .map_err(|e| e.to_string())?;
                    versions.cleanup_pending =
                        serde_json::from_value(event["warnings"].clone()).unwrap_or_default();
                    let status = updater.wait_bounded(Duration::from_secs(15))?;
                    if !status.success() {
                        return Err(format!("更新器异常退出：{status}"));
                    }
                    emit_progress(
                        app,
                        100,
                        "更新完成",
                        if versions.cleanup_pending.is_empty() {
                            "新版本已启动，旧版本已删除。"
                        } else {
                            "新版本已启动；部分旧文件被占用，需重试清理。"
                        },
                        "完成",
                        Some(versions.cleanup_pending.join("\n")),
                    );
                    return Ok(versions);
                }
                _ => return Err("未知更新器事件".into()),
            }
        }
    })();
    if result.is_err() {
        // Stop updater first so a late commit cannot race rollback.
        updater.stop()?;
        if activated
            .as_ref()
            .is_some_and(|id| runtime_store::current_id(root).ok().flatten().as_ref() == Some(id))
        {
            let mut versions = read_runtime_versions(&runtime_store::current(root)?)?;
            versions
                .cleanup_pending
                .push("新版本已提交，但更新器结束异常；请重试旧版本清理".into());
            return Ok(versions);
        }
        if !switched {
            return result;
        }
        stop_existing_child(&state.child)?;
        *state.runtime_url.lock().map_err(|_| "状态锁错误")? = None;
        if runtime_store::complete(&previous) {
            if let Err(rollback) = launch_version(
                app,
                &window,
                state.child.clone(),
                root.into(),
                false,
                Some(previous),
            ) {
                return Err(format!(
                    "{}；旧版本重新启动也失败：{rollback}",
                    result.unwrap_err()
                ));
            }
        }
    }
    result
}

#[tauri::command]
async fn cleanup_runtime(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let _operation = state.operation.lock().map_err(|_| "操作锁错误")?;
        let root = PathBuf::from(read_desktop_config(&app)?.install_dir);
        validate_install_dir(&root)?;
        ensure_owner(&app, &root)?;
        let mut command = Command::new(updater_path(&app)?);
        command
            .arg("cleanup")
            .arg(&root)
            .arg(app.path().resource_dir().map_err(|e| e.to_string())?)
            .arg("latest")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = Child::spawn(&mut command).map_err(|e| e.to_string())?;
        let out = child.stdout.take().ok_or("无法读取清理状态")?;
        let reader = thread::spawn(move || {
            let mut s = String::new();
            BufReader::new(out).read_to_string(&mut s).map(|_| s)
        });
        let status = child.wait_bounded(Duration::from_secs(180))?;
        let text = reader
            .join()
            .map_err(|_| "清理输出异常")?
            .map_err(|e| e.to_string())?;
        let event: serde_json::Value =
            serde_json::from_str(text.trim()).map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(event["message"].as_str().unwrap_or("旧版本清理失败").into());
        }
        serde_json::from_value(event["warnings"].clone()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
    ensure_owner(app, &install_dir)?;
    let _update_lock = runtime_store::lock(&install_dir, "update.lock")?;
    let cleanup = runtime_store::cleanup(&install_dir)?;
    for warning in cleanup {
        emit_progress(
            app,
            100,
            "旧版本清理待完成",
            &warning,
            "清理",
            Some(warning.clone()),
        );
    }
    launch_version(app, window, child_slot, install_dir, navigate, None)
}

fn launch_version(
    app: &AppHandle,
    window: &WebviewWindow,
    child_slot: Arc<Mutex<Option<Child>>>,
    install_dir: PathBuf,
    navigate: bool,
    candidate: Option<PathBuf>,
) -> Result<(), String> {
    validate_install_dir(&install_dir)?;
    if candidate.is_none() && !runtime_is_installed(&install_dir) {
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
    stop_existing_child(&child_slot)?;
    *desktop.runtime_url.lock().map_err(|_| "状态锁错误")? = None;
    let web_port = available_port()?;
    let runtime_port = available_port_excluding(web_port)?;
    let runtime = candidate.unwrap_or(runtime_store::current(&install_dir)?);
    let expected_core = read_runtime_versions(&runtime)?.core_version;
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
        .env("NEO_DESKTOP_LOCAL_RESOURCES", "1")
        .env("NEO_CORE_SOURCE", "package")
        .env("NEO_WEB_DATA_DIR", &data_dir)
        .env("NEO_WORKSPACE_ROOT", &workspace_dir)
        .env("AGENT_VENDOR_DIR", &agent_vendor)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child =
        Child::spawn(&mut command).map_err(|error| format!("无法启动 Neo 服务：{error}"))?;
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
    if let Err(error) = health_check::wait(&url, &expected_core, Duration::from_secs(45)) {
        stop_existing_child(&child_slot)?;
        return Err(error);
    }
    if child_slot
        .lock()
        .map_err(|_| "状态锁错误")?
        .as_mut()
        .ok_or("后台已退出")?
        .try_wait()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        stop_existing_child(&child_slot)?;
        return Err("后台健康检查后意外退出".into());
    }
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
    runtime_store::current(root)
        .map(|p| runtime_store::complete(&p))
        .unwrap_or(false)
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
        cleanup_pending: Vec::new(),
    })
}

fn default_install_dir() -> Result<PathBuf, String> {
    // OS per-user application storage only. Never derive defaults from cwd,
    // the current conversation/session directory, or any of its parents.
    let mut reasons = Vec::new();
    for path in install_storage::candidates() {
        match install_preflight::inspect(&path) {
            Ok(info) if info.nonempty => return Ok(path), // require consent, never auto-delete/fallback
            Ok(_) => match install_storage::probe(&path) {
                Ok(()) => return Ok(path),
                Err(e) => reasons.push(e),
            },
            Err(e) => reasons.push(e),
        }
    }
    Err(format!(
        "默认安装位置不可写，请检查用户应用目录：{}",
        reasons.join("；")
    ))
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
    runtime_store::atomic_json(&desktop_config_path(app)?, &value)
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

fn stop_existing_child(slot: &Arc<Mutex<Option<Child>>>) -> Result<(), String> {
    let mut guard = slot.lock().map_err(|_| "运行时状态锁错误")?;
    if let Some(child) = guard.as_mut() {
        child.stop()?;
    }
    *guard = None;
    Ok(())
}

fn ensure_owner(app: &AppHandle, root: &Path) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let mut owner = state.owner.lock().map_err(|_| "目录所有者状态锁错误")?;
    if let Some((path, _)) = &*owner {
        if install_storage::same_path(path, root) {
            return Ok(());
        }
        return Err("当前桌面实例已关联其他数据目录".into());
    }
    *owner = Some((
        root.to_path_buf(),
        runtime_store::lock(root, "desktop.lock")?,
    ));
    Ok(())
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn display_io(context: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{context}：{error}")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(local_resources::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            sync_window_theme,
            bootstrap_state,
            choose_install_directory,
            inspect_install_directory,
            clear_install_directory,
            install_runtime,
            update_runtime,
            cleanup_runtime,
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
