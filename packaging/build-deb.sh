#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Build the CloverEye .deb (amd64) for Ubuntu 22.04 and newer and Debian 12
# and newer, inside an Ubuntu 22.04 container, so it links against the oldest
# glibc and WebKitGTK 4.1 it supports. Unlike the AppImage it bundles nothing:
# it depends on the system's own WebKitGTK, GTK 3 and GStreamer (apt pulls
# them in), so the source of those is the distribution's.
#
# Usage: packaging/build-deb.sh [out-dir]
#   out-dir defaults to $XDG_CACHE_HOME/clovereye/packaging (never the repo).
#
# Output: clovereye_<version>_amd64.deb
#
# Needs podman. Shares the AppImage build's cached Rust toolchain and Tauri
# CLI (podman volumes clovereye-appimage-cargo and clovereye-appimage-rustup).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-${XDG_CACHE_HOME:-$HOME/.cache}/clovereye/packaging}
mkdir -p "$out"
command -v podman >/dev/null || { echo "podman is not installed" >&2; exit 1; }
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/src-tauri/Cargo.toml" | head -1)

exec podman run --rm -i --security-opt label=disable \
    -v "$repo:/src:ro" -v "$out:/out" \
    -v clovereye-appimage-cargo:/root/.cargo -v clovereye-appimage-rustup:/root/.rustup \
    -e JOBS -e VERSION="$version" \
    docker.io/library/ubuntu:22.04 bash -s <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive PATH=/root/.cargo/bin:$PATH
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends \
    ca-certificates curl file build-essential pkg-config xdg-utils dpkg-dev \
    libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev \
    </dev/null >/tmp/apt.log 2>&1 || { cat /tmp/apt.log >&2; exit 1; }
if ! command -v cargo >/dev/null; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain stable
fi
command -v cargo-tauri >/dev/null || cargo install -q tauri-cli --version '^2' --locked
mkdir /build && cd /src && tar --exclude=./target --exclude=./src-tauri/target --exclude=./.git -cf - . | tar -C /build -xf -
cd /build/src-tauri
CARGO_BUILD_JOBS=${JOBS:-4} cargo tauri build --bundles deb -- --locked
deb=/out/clovereye_${VERSION}_amd64.deb
cp target/release/bundle/deb/*.deb "$deb"
echo "--- control"
dpkg-deb -f "$deb"
echo "--- files"
dpkg-deb -c "$deb" | awk '{print $6}'
echo "$deb ($(du -h "$deb" | cut -f1))"
EOF
