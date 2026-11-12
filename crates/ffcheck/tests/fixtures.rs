//! Parsing against ffmpeg output captured on the build machine
//! (Fedora 44 with ffmpeg 8.1.3 and Fedora 45 with ffmpeg 9.0.2, both from
//! RPM Fusion), Fedora 44's own ffmpeg-free, and Ubuntu 24.04 and 26.04's
//! ffmpeg (whose -filters table has no "------" line), plus one live check
//! of the local ffmpeg that passes whether or not ffmpeg is installed.

use clovereye_ffcheck::{check, parse_encoders, parse_filters, parse_version, table_names, Encoders, Filters};

fn fx(name: &str) -> String {
    std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// Supported Fedora releases and the ffmpeg version captured on each.
const RELEASES: [(&str, &str); 2] = [("fedora44", "8.1.3"), ("fedora45", "9.0.2")];

#[test]
fn every_supported_fedora_has_everything_clip_uses() {
    for (rel, version) in RELEASES {
        assert_eq!(
            parse_encoders(&fx(&format!("{rel}-encoders.txt"))),
            Encoders { libvpx_vp9: true, libsvtav1: true, libopus: true },
            "{rel}"
        );
        assert_eq!(
            parse_filters(&fx(&format!("{rel}-filters.txt"))),
            Filters { ass: true, subtitles: true, libplacebo: true },
            "{rel}"
        );
        assert_eq!(parse_version(&fx(&format!("{rel}-version.txt"))).as_deref(), Some(version), "{rel}");
    }
}

#[test]
fn legend_lines_are_not_mistaken_for_rows() {
    for (rel, _) in RELEASES {
        let enc = table_names(&fx(&format!("{rel}-encoders.txt")));
        assert!(!enc.iter().any(|n| n == "=" || n == "Video"), "{rel}");
        assert!(enc.len() > 150, "{rel}: {} encoders", enc.len());
        assert!(enc.contains(&"libvpx".to_string()), "{rel}: VP8 too");
        let fil = table_names(&fx(&format!("{rel}-filters.txt")));
        assert!(fil.len() > 400, "{rel}: {} filters", fil.len());
        assert!(!fil.iter().any(|n| n == "=" || n == "Timeline"), "{rel}");
    }
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
    for key in ["found", "path", "version", "os", "distro", "encoders", "filters", "package"] {
        assert!(json.get(key).is_some(), "{key} missing from the bridge shape");
    }
    assert!(json["encoders"].get("libvpx_vp9").is_some());
    assert!(json["filters"].get("libplacebo").is_some());
}

/// Other packagings, captured in clean containers on 11 November 2026.
const OTHERS: [(&str, &str); 3] = [("ubuntu2404", "6.1.1-3ubuntu5"), ("ubuntu2604", "8.0.1-3ubuntu2"), ("fedora44-ffmpeg-free", "8.1.3")];

#[test]
fn ubuntu_and_fedora_ffmpeg_free_read_right() {
    for (rel, version) in OTHERS {
        assert_eq!(parse_version(&fx(&format!("{rel}-version.txt"))).as_deref(), Some(version), "{rel}");
        assert_eq!(parse_encoders(&fx(&format!("{rel}-encoders.txt"))), Encoders { libvpx_vp9: true, libsvtav1: true, libopus: true }, "{rel}");
        // Ubuntu's -filters has no separator: the rows must still be found
        assert_eq!(parse_filters(&fx(&format!("{rel}-filters.txt"))), Filters { ass: true, subtitles: true, libplacebo: true }, "{rel}");
    }
}

#[test]
fn a_table_without_a_separator_skips_the_legend() {
    let t = "Filters:\n  T.. = Timeline support\n  A = Audio input/output\n  | = Source or sink filter\n TS aap   AA->A  Apply.\n ... ass  V->V  Render.\n";
    assert_eq!(table_names(t), vec!["aap", "ass"]);
}
