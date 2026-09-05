// The desktop entry point must not allocate a Windows console, including debug builds.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    neoctl_desktop_lib::run();
}
