use std::process::Command;

const BUILTIN: &str = include_str!(concat!(env!("OUT_DIR"), "/control-config.json"));

pub(crate) fn configure(command: &mut Command) -> Result<(), String> {
    apply(command, BUILTIN).map_err(str::to_owned)
}

fn apply(command: &mut Command, config: &str) -> Result<(), &'static str> {
    // Never allow the host environment to override a public/unconfigured build.
    command.env_remove("NEO_DESKTOP_CONTROL_FILE");
    command.env_remove("NEO_DESKTOP_CONTROL_CONFIG");
    command.env_remove("NEO_CONTROL_BUILD_CONFIG");
    if config.trim() != "null" {
        let validated = super::control_config_validation::validate(config.as_bytes())?;
        command.env("NEO_DESKTOP_CONTROL_CONFIG", validated);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unconfigured_build_removes_host_overrides() {
        let mut cmd = Command::new("unused");
        cmd.env("NEO_DESKTOP_CONTROL_CONFIG", "host injection");
        apply(&mut cmd, "null").unwrap();
        for key in ["NEO_DESKTOP_CONTROL_FILE", "NEO_DESKTOP_CONTROL_CONFIG", "NEO_CONTROL_BUILD_CONFIG"] {
            assert!(cmd.get_envs().any(|(k, v)| k == key && v.is_none()));
        }
    }
    #[test]
    fn valid_builtin_is_injected_invalid_is_not() {
        let mut cmd = Command::new("unused");
        let json = serde_json::json!({"enabled":true,"url":"https://control.example.invalid","key":format!("{}=", "A".repeat(43))}).to_string();
        apply(&mut cmd, &json).unwrap();
        assert!(cmd.get_envs().any(|(k, v)| k == "NEO_DESKTOP_CONTROL_CONFIG" && v.is_some()));
        assert!(apply(&mut cmd, "{invalid").is_err());
        assert!(cmd.get_envs().any(|(k, v)| k == "NEO_DESKTOP_CONTROL_CONFIG" && v.is_none()));
    }
}
