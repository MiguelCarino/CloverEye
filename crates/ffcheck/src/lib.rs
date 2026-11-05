//! Checks what the local ffmpeg can do for Clip (SCOPE §3.1b step 5).
//!
//! It runs three read-only commands on the ffmpeg binary: `ffmpeg -version`,
//! `ffmpeg -hide_banner -encoders` and `ffmpeg -hide_banner -filters`. On
//! RPM-based Linux it also asks the RPM database, read-only, which ffmpeg
//! package is installed: Fedora's `ffmpeg-free` first, then RPM Fusion's
//! `ffmpeg` (`rpm -q ffmpeg-free ffmpeg`). It never installs anything, never runs a
//! package manager and never asks for admin rights; when something is
//! missing, the UI shows an install command for the person to copy.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Encoders {
    pub libvpx_vp9: bool,
    pub libsvtav1: bool,
    pub libopus: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Filters {
    pub ass: bool,
    pub subtitles: bool,
    pub libplacebo: bool,
}

/// The shape `ui/js/bridge.js` expects from `check_ffmpeg`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FfmpegCheck {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// "linux" | "macos" | "windows" | other `std::env::consts::OS` values.
    pub os: String,
    /// Linux only: `ID` and `ID_LIKE` from /etc/os-release, space-separated.
    pub distro: Option<String>,
    pub encoders: Encoders,
    pub filters: Filters,
    /// RPM-based Linux only: the installed ffmpeg package, if any.
    pub package: Option<Package>,
    pub error: Option<String>,
}

/// An installed ffmpeg package, from the RPM database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Package {
    /// `ffmpeg-free` (Fedora) or `ffmpeg` (RPM Fusion, or another repo).
    pub name: String,
    pub version: String,
    pub vendor: String,
    /// "fedora" | "rpmfusion" | "other"
    pub source: String,
}

/// The RPM query `check` runs: one line per package, `name\tversion\tvendor`.
pub const RPM_QUERY: [&str; 5] = ["-q", "--qf", "%{NAME}\t%{VERSION}\t%{VENDOR}\n", "ffmpeg-free", "ffmpeg"];

/// Reads `rpm -q --qf ... ffmpeg-free ffmpeg` output ("package x is not
/// installed" lines are skipped). Fedora's `ffmpeg-free` wins when present;
/// otherwise RPM Fusion's (or another repo's) `ffmpeg`.
pub fn parse_rpm_packages(output: &str) -> Option<Package> {
    let found: Vec<Package> = output
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let (name, version, vendor) = (f.next()?, f.next()?, f.next()?);
            if name != "ffmpeg-free" && name != "ffmpeg" {
                return None;
            }
            let v = vendor.to_ascii_lowercase();
            let source = if name == "ffmpeg-free" || v.contains("fedora") {
                "fedora"
            } else if v.contains("rpm fusion") || v.contains("rpmfusion") {
                "rpmfusion"
            } else {
                "other"
            };
            Some(Package { name: name.into(), version: version.into(), vendor: vendor.into(), source: source.into() })
        })
        .collect();
    let free = found.iter().find(|p| p.name == "ffmpeg-free");
    free.or_else(|| found.iter().find(|p| p.name == "ffmpeg")).cloned()
}

/// Asks the RPM database (read-only) where it exists; `None` elsewhere.
fn rpm_package() -> Option<Package> {
    if std::env::consts::OS != "linux" {
        return None;
    }
    let rpm = ["/usr/bin/rpm", "/bin/rpm"].into_iter().map(Path::new).find(|p| p.is_file())?;
    let mut cmd = Command::new(rpm);
    cmd.args(RPM_QUERY).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // rpm exits 1 when one of the two is not installed; the output still counts.
    let out = cmd.output().ok()?;
    parse_rpm_packages(&String::from_utf8_lossy(&out.stdout))
}

/// Names from the table `ffmpeg -encoders` or `-filters` prints: the second
/// column of every row after the `------` separator.
pub fn table_names(output: &str) -> Vec<String> {
    output
        .lines()
        .skip_while(|l| !l.trim_start().starts_with("------"))
        .skip(1)
        .filter_map(|l| l.split_whitespace().nth(1).map(str::to_string))
        .collect()
}

pub fn parse_encoders(output: &str) -> Encoders {
    let names = table_names(output);
    let has = |n: &str| names.iter().any(|x| x == n);
    Encoders {
        libvpx_vp9: has("libvpx-vp9"),
        libsvtav1: has("libsvtav1"),
        libopus: has("libopus"),
    }
}

pub fn parse_filters(output: &str) -> Filters {
    let names = table_names(output);
    let has = |n: &str| names.iter().any(|x| x == n);
    Filters {
        ass: has("ass"),
        subtitles: has("subtitles"),
        libplacebo: has("libplacebo"),
    }
}

/// `ffmpeg version 8.1.3 Copyright ...` → `8.1.3`;
/// `ffmpeg version n7.0-12-gabc ...` → `n7.0-12-gabc`.
pub fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().find(|l| l.starts_with("ffmpeg version "))?;
    line.split_whitespace().nth(2).map(str::to_string)
}

/// `ID` and `ID_LIKE` from an os-release file, lowercase, space-separated.
pub fn parse_os_release(text: &str) -> Option<String> {
    let mut parts = Vec::new();
    for key in ["ID=", "ID_LIKE="] {
        if let Some(line) = text.lines().find(|l| l.starts_with(key)) {
            let v = line[key.len()..].trim().trim_matches(|c| c == '"' || c == '\'');
            if !v.is_empty() {
                parts.push(v.to_ascii_lowercase());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn linux_distro() -> Option<String> {
    if std::env::consts::OS != "linux" {
        return None;
    }
    ["/etc/os-release", "/usr/lib/os-release"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| parse_os_release(&t))
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// The binary to run: a copy bundled next to the app (Windows and macOS
/// builds ship one), else whatever `ffmpeg` is on PATH.
pub fn ffmpeg_binary(app_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = app_dir {
        let bundled = dir.join(exe_name());
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from(exe_name())
}

fn run(bin: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("{} {} exited with {}", bin.display(), args.join(" "), out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Locates ffmpeg on PATH (for display only; `Command` does its own lookup).
fn which(bin: &Path) -> Option<String> {
    if bin.components().count() > 1 {
        return Some(bin.display().to_string());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
        .map(|p| p.display().to_string())
}

/// Runs the check. `app_dir` is the folder of the app executable, where a
/// bundled ffmpeg would sit.
pub fn check(app_dir: Option<&Path>) -> FfmpegCheck {
    let bin = ffmpeg_binary(app_dir);
    let mut result = FfmpegCheck {
        found: false,
        path: None,
        version: None,
        os: std::env::consts::OS.to_string(),
        distro: linux_distro(),
        encoders: Encoders::default(),
        filters: Filters::default(),
        package: rpm_package(),
        error: None,
    };
    let version = match run(&bin, &["-version"]) {
        Ok(v) => v,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };
    result.found = true;
    result.path = which(&bin);
    result.version = parse_version(&version);
    match run(&bin, &["-hide_banner", "-encoders"]) {
        Ok(o) => result.encoders = parse_encoders(&o),
        Err(e) => result.error = Some(e),
    }
    match run(&bin, &["-hide_banner", "-filters"]) {
        Ok(o) => result.filters = parse_filters(&o),
        Err(e) => result.error = Some(e),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpm_prefers_ffmpeg_free_then_rpm_fusion() {
        let both = "ffmpeg-free\t8.1.3\tFedora Project\nffmpeg\t9.0.2\tRPM Fusion\n";
        let p = parse_rpm_packages(both).unwrap();
        assert_eq!((p.name.as_str(), p.source.as_str()), ("ffmpeg-free", "fedora"));
        let fusion = "package ffmpeg-free is not installed\nffmpeg\t9.0.2\tRPM Fusion\n";
        let p = parse_rpm_packages(fusion).unwrap();
        assert_eq!((p.name.as_str(), p.version.as_str(), p.source.as_str()), ("ffmpeg", "9.0.2", "rpmfusion"));
        let other = "package ffmpeg-free is not installed\nffmpeg\t7.1\tSomeone Else\n";
        assert_eq!(parse_rpm_packages(other).unwrap().source, "other");
        assert_eq!(parse_rpm_packages("package ffmpeg-free is not installed\npackage ffmpeg is not installed\n"), None);
        assert_eq!(parse_rpm_packages(""), None);
    }

    #[test]
    fn table_rows_only_after_the_separator() {
        let out = "Encoders:\n V..... = Video\n ------\n V....D libvpx-vp9   libvpx VP9\n A....D libopus  Opus\n";
        assert_eq!(table_names(out), vec!["libvpx-vp9", "libopus"]);
        assert!(table_names("no table here").is_empty());
    }

    #[test]
    fn version_line() {
        assert_eq!(parse_version("ffmpeg version 8.1.3 Copyright (c) 2000-2026"), Some("8.1.3".into()));
        assert_eq!(parse_version("ffmpeg version n7.0-12-gabc Copyright"), Some("n7.0-12-gabc".into()));
        assert_eq!(parse_version("something else"), None);
    }

    #[test]
    fn os_release() {
        assert_eq!(parse_os_release("NAME=Fedora\nID=fedora\nVERSION_ID=44\n"), Some("fedora".into()));
        assert_eq!(parse_os_release("NAME=Fedora Linux\nID=fedora\nVERSION_ID=45\n"), Some("fedora".into()));
        assert_eq!(
            parse_os_release("ID=nobara\nID_LIKE=\"rhel centos fedora\"\n"),
            Some("nobara rhel centos fedora".into())
        );
        assert_eq!(parse_os_release("ID='ubuntu'\nID_LIKE=debian"), Some("ubuntu debian".into()));
        assert_eq!(parse_os_release("NAME=x"), None);
    }

    #[test]
    fn bundled_binary_wins_when_present() {
        let dir = std::env::temp_dir().join(format!("clovereye-ffcheck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(ffmpeg_binary(Some(&dir)), PathBuf::from(exe_name()));
        std::fs::write(dir.join(exe_name()), b"").unwrap();
        assert_eq!(ffmpeg_binary(Some(&dir)), dir.join(exe_name()));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(ffmpeg_binary(None), PathBuf::from(exe_name()));
    }

    #[test]
    fn missing_binary_reports_not_found() {
        let dir = std::env::temp_dir();
        let r = {
            let bin = dir.join("definitely-not-ffmpeg-clovereye");
            run(&bin, &["-version"])
        };
        assert!(r.is_err());
    }
}
