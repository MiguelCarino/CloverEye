#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Build the CloverEye binary RPM for the Fedora release this runs on.
#
# Usage: packaging/build-rpm.sh [out-dir]
#   out-dir defaults to $XDG_CACHE_HOME/clovereye/packaging (never the repo).
#
# Needs: cargo, rpm-build, and the WebKitGTK/GTK 3 development packages from
# the README. Never runs a package manager or sudo. For another Fedora
# release, run packaging/build-in-container.sh instead.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-${XDG_CACHE_HOME:-$HOME/.cache}/clovereye/packaging}
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/src-tauri/Cargo.toml" | head -1)
dist=$(rpm --eval '%{?dist}')
[ -n "$dist" ] || { echo "rpm has no %dist here; run this on Fedora" >&2; exit 1; }

# The same release build `cargo tauri build` makes: the UI is embedded from
# ui/ through the custom protocol, no dev server.
(cd "$repo/src-tauri" && CARGO_BUILD_JOBS=${JOBS:-4} cargo build --release --locked --features tauri/custom-protocol)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$repo/src-tauri/target/release/clovereye" "$stage/"
cp "$repo/packaging/clovereye.desktop" "$repo/LICENSE" "$repo/README.md" "$stage/"
cp "$repo/ui/fonts/Inter-OFL.txt" "$repo/ui/fonts/NotoSansMono-OFL.txt" "$stage/"
icons="$repo/src-tauri/icons"
cp "$icons/32x32.png" "$stage/icon-32.png"
cp "$icons/64x64.png" "$stage/icon-64.png"
cp "$icons/128x128.png" "$stage/icon-128.png"
cp "$icons/128x128@2x.png" "$stage/icon-256.png"
cp "$icons/icon.png" "$stage/icon-512.png"

mkdir -p "$out"
rpmbuild -bb "$repo/packaging/clovereye.spec" \
    --define "ce_version $version" \
    --define "_sourcedir $stage" \
    --define "_topdir $stage/rpmbuild" \
    --define "_rpmdir $out" \
    --define "_build_name_fmt %%{NAME}-%%{VERSION}-%%{RELEASE}.%%{ARCH}.rpm" \
    >"$stage/rpmbuild.log" 2>&1 || { cat "$stage/rpmbuild.log" >&2; exit 1; }
echo "$out/clovereye-$version-1$dist.x86_64.rpm"
