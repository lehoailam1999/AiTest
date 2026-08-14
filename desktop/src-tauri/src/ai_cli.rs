use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const VERSION_TIMEOUT_SECS: u64 = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliVersionOut {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

fn first_path_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(|s| s.trim())
        .find(|s| !s.is_empty() && !s.eq_ignore_ascii_case("info: could not find files"))
        .map(|s| s.to_string())
}

fn which_in_path_dirs(name: &str) -> Option<PathBuf> {
    let path_os = std::env::var_os("PATH")?;
    let has_suffix = Path::new(name).extension().is_some();
    for dir in std::env::split_paths(&path_os) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        if has_suffix {
            continue;
        }
        #[cfg(windows)]
        {
            for ext in [".ps1", ".cmd", ".exe", ".bat"] {
                let cand = dir.join(format!("{name}{ext}"));
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

fn where_exe(name: &str) -> Option<String> {
    if let Some(p) = which_in_path_dirs(name) {
        return Some(p.to_string_lossy().into_owned());
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("where");
        cmd.arg(name);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        return first_path_line(&text);
    }
    #[cfg(not(windows))]
    {
        let out = Command::new("sh")
            .args(["-c", &format!("command -v -- {}", shell_single_quote(name))])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        return first_path_line(&text);
    }
}

#[cfg(not(windows))]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn powershell_exe() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| {
        #[cfg(windows)]
        {
            "C:\\Windows".into()
        }
        #[cfg(not(windows))]
        {
            "/".into()
        }
    });
    PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

fn spawn_version(executable: &Path, args: &[String]) -> Result<std::process::Output, String> {
    let exe_s = executable.to_string_lossy();
    #[cfg(windows)]
    {
        if exe_s.to_ascii_lowercase().ends_with(".ps1") {
            let mut cmd = Command::new(powershell_exe());
            cmd.args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]);
            cmd.arg(executable);
            cmd.args(args);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd
                .output()
                .map_err(|e| format!("permission/process: {e}"));
        }
        if exe_s.to_ascii_lowercase().ends_with(".cmd")
            || exe_s.to_ascii_lowercase().ends_with(".bat")
        {
            let mut parts: Vec<String> = vec![exe_s.into_owned()];
            parts.extend(args.iter().cloned());
            let cmdline = parts
                .into_iter()
                .map(|p| {
                    if p.contains(' ') {
                        format!("\"{p}\"")
                    } else {
                        p
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let mut cmd = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
            cmd.args(["/d", "/s", "/c", &cmdline]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd
                .output()
                .map_err(|e| format!("permission/process: {e}"));
        }
        let mut cmd = Command::new(executable);
        cmd.args(args);
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd
            .output()
            .map_err(|e| format!("permission/process: {e}"));
    }
    #[cfg(not(windows))]
    {
        Command::new(executable)
            .args(args)
            .output()
            .map_err(|e| format!("permission/process: {e}"))
    }
}

#[tauri::command]
pub fn ai_cli_which(name: String) -> Option<String> {
    let n = name.trim();
    if n.is_empty() || n.contains(['/', '\\']) {
        return None;
    }
    where_exe(n)
}

#[tauri::command]
pub fn ai_cli_is_file(path: String) -> bool {
    let p = PathBuf::from(path.trim());
    p.is_file()
}

#[tauri::command]
pub fn ai_cli_run_version(executable: String, args: Vec<String>) -> AiCliVersionOut {
    let path = PathBuf::from(executable.trim());
    if !path.is_file() {
        return AiCliVersionOut {
            exit_code: -1,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("CLI path is not a file.".into()),
        };
    }

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(spawn_version(&path, &args));
    });
    match rx.recv_timeout(Duration::from_secs(VERSION_TIMEOUT_SECS)) {
        Err(_) => AiCliVersionOut {
            exit_code: -1,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("Version check timed out.".into()),
        },
        Ok(Err(e)) => AiCliVersionOut {
            exit_code: -1,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(e),
        },
        Ok(Ok(out)) => {
            let code = out.status.code().unwrap_or(-1);
            AiCliVersionOut {
                exit_code: code,
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                error: None,
            }
        }
    }
}

#[tauri::command]
pub fn ai_cli_user_env() -> HashMap<String, String> {
    let mut out = HashMap::new();
    for key in ["LOCALAPPDATA", "HOME", "USERPROFILE"] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                out.insert(key.to_string(), v);
            }
        }
    }
    out
}
