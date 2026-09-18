//! Separate updater executable: never loads the installed backend or its Node executable.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[path = "../directory_gate.rs"]
mod directory_gate;
#[path = "../install_path.rs"]
mod install_path;
#[path = "../managed_process.rs"]
mod managed_process;
#[path = "../node_isolation.rs"]
mod node_isolation;
#[path = "../runtime_store.rs"]
mod runtime_store;
use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
// Use npm's canonical registry; do not disable TLS verification for mirror failures.
const REGISTRY: &str = "https://registry.npmjs.org";
fn send(v: serde_json::Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{}", v);
    let _ = out.flush();
}
fn log(text: impl AsRef<str>) {
    send(serde_json::json!({"event":"log","message":text.as_ref()}));
}
fn copy(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for e in fs::read_dir(source).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let p = e.path();
        runtime_store::plain(&p)?;
        if e.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy(&p, &target.join(e.file_name()))?;
        } else {
            fs::copy(p, target.join(e.file_name())).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 5 {
        return Err(
            "usage: neoctl-updater <prepare|cleanup> <root> <resources> <latest|bundled>".into(),
        );
    }
    let root = PathBuf::from(&args[2]);
    let resources = PathBuf::from(&args[3]);
    install_path::validate_install_dir(&root)?;
    let _lock = runtime_store::lock(&root, "update.lock")?;
    let prior = runtime_store::cleanup(&root)?;
    if args[1] == "cleanup" {
        send(serde_json::json!({"event":"done","warnings":prior}));
        return Ok(());
    }
    if args[1] != "prepare" {
        return Err("unknown updater operation".into());
    }
    for warning in prior {
        log(warning);
    }
    let tx = runtime_store::begin(&root)?;
    let candidate = runtime_store::release(&root, &tx.candidate)?;
    fs::create_dir(&candidate).map_err(|e| e.to_string())?;
    let bundled = args[4] == "bundled";
    if !bundled && args[4] != "latest" {
        return Err("unknown package source".into());
    }
    fs::write(candidate.join("package.json"),serde_json::to_vec_pretty(&serde_json::json!({"name":"neoctl-desktop-runtime","private":true,"version":"1.0.0","dependencies":{"neoctl-web":if bundled{"file:packages/neoctl-web.tgz"}else{"latest"}}})).unwrap()).map_err(|e|e.to_string())?;
    log("正在独立版本目录准备 Node.js；不会覆盖旧版本。");
    copy(&resources.join("node"), &candidate.join("node"))?;
    if bundled {
        fs::create_dir(candidate.join("packages")).map_err(|e| e.to_string())?;
        fs::copy(
            resources.join("payload/neoctl-web.tgz"),
            candidate.join("packages/neoctl-web.tgz"),
        )
        .map_err(|e| e.to_string())?;
    }
    let node = candidate.join("node/node.exe");
    let npm = candidate.join("node/node_modules/npm/bin/npm-cli.js");
    let mut cmd = Command::new(&node);
    node_isolation::configure(
        &mut cmd,
        &root,
        &candidate,
        &candidate,
        node_isolation::Phase::Install,
    )?;
    cmd.arg(npm)
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = managed_process::ManagedChild::spawn(&mut cmd).map_err(|e| e.to_string())?;
    let out = child.stdout.take().ok_or("npm stdout missing")?;
    let err = child.stderr.take().ok_or("npm stderr missing")?;
    let a = std::thread::spawn(move || {
        for line in io::BufReader::new(out).lines().map_while(Result::ok) {
            log(line);
        }
    });
    let b = std::thread::spawn(move || {
        for line in io::BufReader::new(err).lines().map_while(Result::ok) {
            log(line);
        }
    });
    let status = child.wait_bounded(Duration::from_secs(1200))?;
    child.stop()?;
    let _ = a.join();
    let _ = b.join();
    if !status.success() {
        return Err(format!("npm 安装失败：{status}；旧版本未改变"));
    }
    // Resolve actual installed manifests and verify Web's declared Core range using this release's npm semver.
    let script = r#"const fs=require('fs'),p=require('path');const root=process.argv[1];const w=p.join(root,'node_modules/neoctl-web');const web=require(p.join(w,'package.json'));const core=require(require.resolve('neoctl/package.json',{paths:[w]}));const semver=require(p.join(root,'node/node_modules/npm/node_modules/semver'));if(!semver.satisfies(core.version,web.dependencies.neoctl))throw Error('Core version incompatible');if(!fs.existsSync(p.join(w,'server.mjs')))throw Error('server missing');console.log(JSON.stringify({web_version:web.version,core_version:core.version,core_requirement:web.dependencies.neoctl}));"#;
    let mut check = Command::new(&node);
    node_isolation::configure(
        &mut check,
        &root,
        &candidate,
        &candidate,
        node_isolation::Phase::Install,
    )?;
    check
        .args(["-e", script])
        .arg(&candidate)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut check = managed_process::ManagedChild::spawn(&mut check).map_err(|e| e.to_string())?;
    let output = check.stdout.take().ok_or("validation stdout missing")?;
    if !check.wait_bounded(Duration::from_secs(30))?.success() {
        return Err("候选 Web / Core 完整性校验失败".into());
    }
    check.stop()?;
    drop(check);
    let line = io::BufReader::new(output)
        .lines()
        .next()
        .ok_or("missing versions")?
        .map_err(|e| e.to_string())?;
    let versions: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    let receipt = serde_json::json!({"schema":1,"web_package":format!("neoctl-web@{}",versions["web_version"].as_str().unwrap_or("")),"installed_at":tx.candidate,"registry":REGISTRY,"web_version":versions["web_version"],"core_version":versions["core_version"],"core_requirement":versions["core_requirement"],"source":if bundled{"bundled"}else{"registry-latest"}});
    runtime_store::atomic_json(&candidate.join("neo-desktop-runtime.json"), &receipt)?;
    send(serde_json::json!({"event":"ready","candidate":tx.candidate,"versions":versions}));
    // Parent owns backend health check. EOF/abort never changes current.json.
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut decision = String::new();
        let _ = io::stdin().read_line(&mut decision);
        let _ = sender.send(decision);
    });
    let decision = receiver
        .recv_timeout(Duration::from_secs(120))
        .unwrap_or_default();
    if decision.trim() != "commit" {
        let warnings = runtime_store::cleanup(&root)?;
        send(serde_json::json!({"event":"aborted","warnings":warnings}));
        return Ok(());
    }
    runtime_store::commit(&root, &tx)?;
    // Commit is the success boundary. Cleanup problems are explicit, retryable warnings.
    let warnings = runtime_store::cleanup(&root).unwrap_or_else(|e| vec![e]);
    send(serde_json::json!({"event":"done","versions":versions,"warnings":warnings}));
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        send(serde_json::json!({"event":"error","message":error}));
        std::process::exit(1);
    }
}
