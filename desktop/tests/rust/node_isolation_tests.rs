use super::*;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    base: PathBuf,
    root: PathBuf,
    staging: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "neo isolation {} {}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&base).unwrap();
        let root = base.join("app");
        let staging = root.join(".runtime-staging");
        fs::create_dir_all(&staging).unwrap();
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/node");
        assert!(
            source.join("node.exe").is_file(),
            "Tests require bundled desktop/resources/node"
        );
        crate::copy_dir_recursive(&source, &staging.join("node")).unwrap();
        fs::write(
            base.join(".npmrc"),
            "tag=HOST_ANCESTOR\nignore-scripts=true\n",
        )
        .unwrap();
        fs::write(base.join("package.json"), "{\"name\":\"host-project\"}").unwrap();
        fs::write(base.join("host.npmrc"), "tag=HOST_USER\n").unwrap();
        Self {
            base,
            root,
            staging,
        }
    }
    fn command(&self, runtime: &Path, cwd: &Path, phase: Phase) -> Command {
        let mut cmd = Command::new(runtime.join("node/node.exe"));
        for key in [
            "nOdE_OpTiOnS",
            "NoDe_PaTh",
            "NVM_HOME",
            "nVm_SyMlInK",
            "COREPACK_HOME",
            "VOLTA_HOME",
            "npm_execpath",
            "npm_node_execpath",
            "NPM_CONFIG_PREFIX",
            "npm_config_cache",
            "NPM_CONFIG_DEVDIR",
            "npm_config_script_shell",
            "npm_config_globalconfig",
        ] {
            cmd.env(key, "HOST_POISON");
        }
        cmd.env("NPM_CONFIG_USERCONFIG", self.base.join("host.npmrc"));
        cmd.env("npm_config_tag", "HOST_ENV")
            .env("npm_config_global", "true");
        cmd.env("ComSpec", "HOST_POISON").env("PATH", &self.base);
        configure(&mut cmd, &self.root, runtime, cwd, phase).unwrap();
        cmd
    }
    fn npm(&self, runtime: &Path, cwd: &Path, phase: Phase, args: &[&str]) -> String {
        let output = self
            .command(runtime, cwd, phase)
            .arg(runtime.join("node/node_modules/npm/bin/npm-cli.js"))
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    fn verify(&self, runtime: &Path, cwd: &Path, phase: Phase) {
        let output = self.command(runtime, cwd, phase).args(["-e", "const c=require('child_process'); console.log(JSON.stringify({exec:process.execPath,child:c.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(),env:process.env}));"]).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let v: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            PathBuf::from(v["exec"].as_str().unwrap()),
            runtime.join("node/node.exe")
        );
        assert_eq!(v["exec"], v["child"]);
        let env = v["env"].as_object().unwrap();
        assert!(!env
            .values()
            .any(|v| v.as_str().unwrap_or("").contains("HOST_POISON")));
        let path = env
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("path"))
            .unwrap()
            .1
            .as_str()
            .unwrap();
        let paths: Vec<_> = std::env::split_paths(path).collect();
        assert_eq!(paths[0], runtime.join("node"));
        assert_eq!(paths.contains(&self.base), matches!(phase, Phase::Runtime));
        let config: serde_json::Value =
            serde_json::from_str(&self.npm(runtime, cwd, phase, &["config", "list", "--json"]))
                .unwrap();
        for (key, leaf) in [
            ("userconfig", "user.npmrc"),
            ("globalconfig", "global.npmrc"),
            ("cache", "cache"),
            ("prefix", "prefix"),
            ("devdir", "node-gyp"),
        ] {
            assert_eq!(
                PathBuf::from(config[key].as_str().unwrap()),
                self.root.join(".neo-node").join(leaf),
                "{key}"
            );
        }
        assert_eq!(config["tag"], "latest");
        assert_eq!(config["ignore-scripts"], false);
        assert_eq!(config["global"], false);
        assert_eq!(
            fs::read_to_string(self.base.join("host.npmrc")).unwrap(),
            "tag=HOST_USER\n"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn polluted_children_and_npm_configs_survive_staging_rename() {
    let f = Fixture::new();
    f.verify(&f.staging, &f.staging, Phase::Install);
    let runtime = f.root.join("runtime");
    fs::rename(&f.staging, &runtime).unwrap();
    f.verify(&runtime, &f.root.join("data"), Phase::Runtime);
    for tool in ["git", "python"] {
        fs::write(
            f.base.join(format!("{tool}.cmd")),
            format!("@echo user-{tool}\r\n"),
        )
        .unwrap();
    }
    let tools = f.command(&runtime, &f.root.join("data"), Phase::Runtime)
        .args(["-e", "const c=require('child_process'); for (const t of ['git','python']) console.log(c.execSync(t,{encoding:'utf8'}).trim());"])
        .output().unwrap();
    assert!(
        tools.status.success(),
        "{}",
        String::from_utf8_lossy(&tools.stderr)
    );
    assert_eq!(
        String::from_utf8(tools.stdout).unwrap().replace('\r', ""),
        "user-git\nuser-python\n"
    );
    // The renamed local config must contain no stale staging paths either.
    assert!(!fs::read_to_string(runtime.join(".npmrc"))
        .unwrap()
        .contains("staging"));
}

#[test]
fn offline_install_lifecycle_resolves_private_node_and_npm() {
    let f = Fixture::new();
    let script = r#"const c=require('child_process'),fs=require('fs'); const node=c.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(); const npm=c.execSync('npm config get cache',{encoding:'utf8'}).trim(); let nvm=false; try { c.execSync('nvm version',{stdio:'pipe'}); nvm=true; } catch {} fs.writeFileSync('probe.json', JSON.stringify({node,npm,nvm,devdir:process.env.npm_config_devdir}));"#;
    fs::write(f.staging.join("probe.cjs"), script).unwrap();
    fs::write(f.staging.join("package.json"), r#"{"name":"neoctl-desktop-runtime","version":"1.0.0","private":true,"scripts":{"postinstall":"node probe.cjs"}}"#).unwrap();
    fs::write(f.base.join("npm.cmd"), "@echo HOST_NPM\r\n").unwrap();
    fs::write(f.base.join("nvm.cmd"), "@echo HOST_NVM\r\n").unwrap();
    f.npm(
        &f.staging,
        &f.staging,
        Phase::Install,
        &[
            "install",
            "--offline",
            "--no-audit",
            "--no-fund",
            "--foreground-scripts",
        ],
    );
    let v: serde_json::Value =
        serde_json::from_slice(&fs::read(f.staging.join("probe.json")).unwrap()).unwrap();
    assert_eq!(
        PathBuf::from(v["node"].as_str().unwrap()),
        f.staging.join("node/node.exe")
    );
    assert_eq!(
        PathBuf::from(v["npm"].as_str().unwrap()),
        f.root.join(".neo-node/cache")
    );
    assert_eq!(
        PathBuf::from(v["devdir"].as_str().unwrap()),
        f.root.join(".neo-node/node-gyp")
    );
    assert_eq!(v["nvm"], false);
}

#[test]
fn mixed_case_environment_filter() {
    for key in [
        "npm_config_cache",
        "NpM_ExecPath",
        "nOdE_OpTiOnS",
        "NVM_HOME",
        "corepack_home",
        "Volta_Home",
        "YARN_RC_FILENAME",
        "PNPM_HOME",
        "PREFIX",
        "GYP_DEFINES",
    ] {
        assert!(injected(key), "{key}");
    }
    for key in [
        "HOME",
        "USERPROFILE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "GIT_SSH_COMMAND",
        "PYTHONPATH",
    ] {
        assert!(!injected(key), "{key}");
    }
}
