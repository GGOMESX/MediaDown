use std::io;
use std::path::Path;
use std::process::{Child, Command};

/// Hides the console window that Windows would otherwise flash for every yt-dlp/ffmpeg run.
pub fn configure_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Owns a download's whole process tree (yt-dlp and the ffmpeg it spawns).
/// On Windows a Job Object kills every member on cancel, and also when the host exits,
/// so closing the browser never leaves orphan ffmpeg processes behind.
pub struct ProcessTree {
    #[cfg(windows)]
    job: windows_job::JobHandle,
}

impl ProcessTree {
    pub fn attach(child: &Child) -> io::Result<Self> {
        #[cfg(windows)]
        return Ok(Self { job: windows_job::JobHandle::for_child(child)? });
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    pub fn terminate(&self, child: &mut Child) -> io::Result<()> {
        #[cfg(windows)]
        {
            let _ = child;
            self.job.terminate()
        }
        #[cfg(not(windows))]
        child.kill()
    }
}

pub fn reveal_in_file_manager(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer needs exactly `/select,"<path>"`; Windows paths cannot contain quotes.
        Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", path.display())).spawn()?;
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn()?;
    }
    Ok(())
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    };

    pub struct JobHandle(HANDLE);

    // A job handle is a kernel object reference, safe to use from any thread.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        pub fn for_child(child: &Child) -> io::Result<Self> {
            // SAFETY: plain Win32 calls; every handle is checked and owned by JobHandle (closed on drop).
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let handle = JobHandle(job);

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if configured == 0 {
                    return Err(io::Error::last_os_error());
                }
                if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(handle)
            }
        }

        pub fn terminate(&self) -> io::Result<()> {
            // SAFETY: self.0 is a valid job handle for the lifetime of self.
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // SAFETY: closing the handle we own; with KILL_ON_JOB_CLOSE this also ends the tree.
            unsafe { CloseHandle(self.0) };
        }
    }
}
