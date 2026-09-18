//! Own the whole Windows process tree, including children whose parent exits first.
use std::{
    io,
    process::{Child, Command, ExitStatus},
    thread,
    time::{Duration, Instant},
};
pub struct ManagedChild {
    pub child: Child,
    #[cfg(windows)]
    job: Job,
}
impl std::ops::Deref for ManagedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl std::ops::DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
impl ManagedChild {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::{
                mem::size_of,
                os::windows::{io::AsRawHandle, process::CommandExt},
                ptr::null,
            };
            use windows_sys::Win32::System::{
                JobObjects::*,
                Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED},
            };
            let handle = unsafe { CreateJobObjectW(null(), null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            // Assign before any package code can spawn children; no breakaway is allowed.
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            let mut child = command.spawn()?;
            if unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as _) } == 0 {
                let e = io::Error::last_os_error();
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
            #[link(name = "ntdll")]
            extern "system" {
                fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
            }
            let status = unsafe { NtResumeProcess(child.as_raw_handle() as _) };
            if status < 0 {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::other(format!("NtResumeProcess: {status:#x}")));
            }
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                child: command.spawn()?,
            })
        }
    }
    pub fn stop(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::*;
            if unsafe { TerminateJobObject(self.job.0, 1) } == 0 {
                return Err(format!(
                    "终止受管后台进程树失败：{}",
                    io::Error::last_os_error()
                ));
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
                    unsafe { std::mem::zeroed() };
                if unsafe {
                    QueryInformationJobObject(
                        self.job.0,
                        JobObjectBasicAccountingInformation,
                        &mut info as *mut _ as _,
                        std::mem::size_of_val(&info) as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error().to_string());
                }
                if info.ActiveProcesses == 0 {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("等待受管后台进程树退出超时；未允许版本切换".into());
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        #[cfg(not(windows))]
        {
            if self.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                self.child.kill().map_err(|e| e.to_string())?;
            }
        }
        self.child.wait().map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn wait_bounded(&mut self, timeout: Duration) -> Result<ExitStatus, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(s) = self.child.try_wait().map_err(|e| e.to_string())? {
                return Ok(s);
            }
            if Instant::now() >= deadline {
                self.stop()?;
                return Err("进程执行超时，已停止受管进程树".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn descendants_are_stopped_after_parent_exits() {
        let node =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/node/node.exe");
        let mut c = Command::new(&node);
        c.args(["-e", "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','console.log(1);setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','ignore']});c.on('error',()=>process.exit(2));c.stdout.once('data',()=>{c.stdout.destroy();c.unref();});"]);
        let mut p = ManagedChild::spawn(&mut c).unwrap();
        assert!(p.wait_bounded(Duration::from_secs(10)).unwrap().success());
        use windows_sys::Win32::System::JobObjects::*;
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        assert_ne!(
            unsafe {
                QueryInformationJobObject(
                    p.job.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert!(
            info.ActiveProcesses > 0,
            "descendant survives exited parent before stop"
        );
        p.stop().unwrap();
        assert_ne!(
            unsafe {
                QueryInformationJobObject(
                    p.job.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(info.ActiveProcesses, 0);
    }
    #[test]
    fn timeout_stops_process_tree() {
        let mut c = Command::new("cmd.exe");
        c.args(["/d", "/c", "ping -n 120 127.0.0.1 >nul"]);
        let mut p = ManagedChild::spawn(&mut c).unwrap();
        assert!(p.wait_bounded(Duration::from_millis(100)).is_err());
        assert!(p.try_wait().unwrap().is_some());
    }
    #[test]
    fn managed_process_stops_and_reaps() {
        let mut c = Command::new("cmd.exe");
        c.args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]);
        let mut p = ManagedChild::spawn(&mut c).unwrap();
        assert!(p.try_wait().unwrap().is_none());
        p.stop().unwrap();
        assert!(p.try_wait().unwrap().is_some());
    }
}
