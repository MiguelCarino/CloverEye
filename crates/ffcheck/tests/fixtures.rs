//! Parsing against ffmpeg output captured on the build machine
//! (Fedora 44, ffmpeg 8.1.3 from RPM Fusion), plus one live check of the
//! local ffmpeg that passes whether or not ffmpeg is installed.

use clovereye_ffcheck::{check, parse_encoders, parse_filters, parse_version, table_names, Encoders, Filters};

fn fx(name: &str) -> String {
    std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

#[test]
fn fedora44_has_everything_clip_uses() {
    assert_eq!(
        parse_encoders(&fx("fedora44-encoders.txt")),
        Encoders { libvpx_vp9: true, libsvtav1: true, libopus: true }
    );
    assert_eq!(
        parse_filters(&fx("fedora44-filters.txt")),
        Filters { ass: true, subtitles: true, libplacebo: true }
    );
    assert_eq!(parse_version(&fx("fedora44-version.txt")).as_deref(), Some("8.1.3"));
}

#[test]
fn legend_lines_are_not_mistaken_for_rows() {
    let enc = table_names(&fx("fedora44-encoders.txt"));
    assert!(!enc.iter().any(|n| n == "=" || n == "Video"));
    assert!(enc.len() > 150, "{} encoders", enc.len());
    assert!(enc.contains(&"libvpx".to_string()), "VP8 too");
    let fil = table_names(&fx("fedora44-filters.txt"));
    assert!(fil.len() > 400, "{} filters", fil.len());
    assert!(!fil.iter().any(|n| n == "=" || n == "Timeline"));
}

#[test]
fn a_build_without_the_libraries_reports_them_missing() {
    let enc = fx("fedora44-encoders.txt")
        .lines()
        .filter(|l| !l.contains("libvpx-vp9") && !l.contains("libsvtav1"))
        .collect::<Vec<_>>()
        .join("\n");
    let e = parse_encoders(&enc);
    assert!(!e.libvpx_vp9 && !e.libsvtav1 && e.libopus);
    let fil = fx("fedora44-filters.txt")
        .lines()
        .filter(|l| !l.contains(" libplacebo ") && !l.contains(" ass ") && !l.contains(" subtitles "))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(parse_filters(&fil), Filters::default());
}

#[test]
fn live_check_of_the_local_ffmpeg_is_well_formed() {
    let r = check(None);
    assert!(!r.os.is_empty());
    if r.found {
        assert!(r.version.is_some(), "{r:?}");
        assert!(r.path.is_some(), "{r:?}");
    } else {
        assert!(r.error.is_some());
        assert_eq!(r.encoders, Encoders::default());
    }
    let json = serde_json::to_value(&r).unwrap();
    for key in ["found", "path", "version", "os", "distro", "encoders", "filters"] {
        assert!(json.get(key).is_some(), "{key} missing from the bridge shape");
    }
    assert!(json["encoders"].get("libvpx_vp9").is_some());
    assert!(json["filters"].get("libplacebo").is_some());
}
