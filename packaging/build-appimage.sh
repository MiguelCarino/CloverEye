#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Build the CloverEye AppImage (x86_64) for Linux distributions other than
# Fedora, inside an Ubuntu 22.04 container so it runs on glibc 2.35 and newer,
# and the Corresponding Source tar that goes with it.
#
# Usage: packaging/build-appimage.sh [--no-sources] [out-dir]
#   out-dir defaults to $XDG_CACHE_HOME/clovereye/packaging (never the repo).
#   --no-sources skips the sources tar: for a quick local rebuild, never for
#   a release.
#
# Output:
#   CloverEye-<version>-x86_64.AppImage
#   CloverEye-<version>-appimage-sources.tar   (several hundred MB)
#
# The AppImage bundles WebKitGTK, GTK 3, GStreamer and their dependencies
# from Ubuntu 22.04 (LGPL and other licences that require the source to be
# offered). packaging/appimage-sources.py traces every bundled file to its
# Ubuntu source package through dpkg's own file lists, and `apt-get source
# --download-only` fetches exactly those versions. The tar also carries
# CloverEye's own source as built, and the list of every bundled file with
# its package (files.tsv), so the mapping can be checked.
#
# Needs podman. The repository is mounted read-only and copied in (uncommitted
# edits included); SELinux labelling is off for the container so the host
# files keep their labels. Inside, rustup installs a stable Rust and cargo
# installs the Tauri CLI, whose AppImage bundler downloads linuxdeploy and its
# GTK and GStreamer plugins; all of that is cached in the podman volumes
# clovereye-appimage-cargo and clovereye-appimage-rustup. The AppImage bundles
# WebKitGTK and GStreamer (tauri.conf.json bundleMediaFramework), so WebM
# should play without the host's codecs.
set -euo pipefail

sources=1
if [ "${1:-}" = "--no-sources" ]; then sources=0; shift; fi
repo=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-${XDG_CACHE_HOME:-$HOME/.cache}/clovereye/packaging}
mkdir -p "$out"
command -v podman >/dev/null || { echo "podman is not installed" >&2; exit 1; }
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/src-tauri/Cargo.toml" | head -1)
commit=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)
git -C "$repo" diff --quiet HEAD 2>/dev/null || commit="$commit (with uncommitted changes)"

exec podman run --rm -i --security-opt label=disable \
    -v "$repo:/src:ro" -v "$out:/out" \
    -v clovereye-appimage-cargo:/root/.cargo -v clovereye-appimage-rustup:/root/.rustup \
    -e JOBS -e VERSION="$version" -e COMMIT="$commit" -e SOURCES="$sources" \
    docker.io/library/ubuntu:22.04 bash -s <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive PATH=/root/.cargo/bin:$PATH APPIMAGE_EXTRACT_AND_RUN=1
# deb-src for `apt-get source` (the sources tar): every pocket the binaries
# can come from, including -updates and -security
cat >/etc/apt/sources.list.d/clovereye-src.list <<SRC
deb-src http://archive.ubuntu.com/ubuntu/ jammy main restricted universe multiverse
deb-src http://archive.ubuntu.com/ubuntu/ jammy-updates main restricted universe multiverse
deb-src http://security.ubuntu.com/ubuntu/ jammy-security main restricted universe multiverse
SRC
apt-get update -qq >/dev/null
# Bring the image's own packages to the archive's current versions: the
# source indexes only list those, and the AppImage should bundle them anyway.
apt-get upgrade -y -qq </dev/null >/tmp/upgrade.log 2>&1 || { cat /tmp/upgrade.log >&2; exit 1; }
apt-get install -y -qq --no-install-recommends \
    ca-certificates curl file build-essential pkg-config xdg-utils patchelf python3 \
    libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    </dev/null >/tmp/apt.log 2>&1 || { cat /tmp/apt.log >&2; exit 1; }
if ! command -v cargo >/dev/null; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain stable
fi
command -v cargo-tauri >/dev/null || cargo install -q tauri-cli --version '^2' --locked
mkdir /build && cd /src && tar --exclude=./target --exclude=./src-tauri/target --exclude=./.git -cf - . | tar -C /build -xf -
cd /build/src-tauri
CARGO_BUILD_JOBS=${JOBS:-4} cargo tauri build --verbose --bundles appimage -- --locked
app=/out/CloverEye-$VERSION-x86_64.AppImage
cp target/release/bundle/appimage/*.AppImage "$app"
chmod 0755 "$app"
echo "$app"
[ "$SOURCES" = 1 ] || exit 0

# ------------------------------------------------------- Corresponding Source
name=CloverEye-$VERSION-appimage-sources
src=/tmp/srctar/$name
mkdir -p "$src/ubuntu"
python3 /build/packaging/appimage-sources.py target/release/bundle/appimage/CloverEye.AppDir "$src"
mkdir "$src/clovereye"
(cd /src && tar --exclude=./target --exclude=./src-tauri/target --exclude=./.git -cf - .) | tar -C "$src/clovereye" -xf -
cp -r target/release/bundle/appimage/CloverEye.AppDir/apprun-hooks "$src/appimage-tools-apprun-hooks"
while IFS=$'\t' read -r pkg ver; do
  mkdir -p "$src/ubuntu/$pkg"
  (cd "$src/ubuntu/$pkg" && apt-get source -qq --download-only "$pkg=$ver" >/dev/null 2>"/tmp/apt-source-$pkg.log") \
    || { echo "apt-get source $pkg=$ver failed:" >&2; cat "/tmp/apt-source-$pkg.log" >&2; exit 1; }
done <"$src/sources.tsv"
cat >"$src/README.txt" <<README
CloverEye $VERSION, AppImage for x86_64 Linux: Corresponding Source
=====================================================================

This archive is the source for everything in CloverEye-$VERSION-x86_64.AppImage.

clovereye/      CloverEye's own source as built (AGPL-3.0-only), from
                https://github.com/MiguelCarino/CloverEye commit $COMMIT.
                The Rust crates it compiles in are pinned by Cargo.lock and
                src-tauri/Cargo.lock; all are on crates.io.
ubuntu/<pkg>/   The Ubuntu 22.04 source package (.dsc, original tarball,
                Debian changes) for every library, plugin and helper the
                AppImage bundles: WebKitGTK, GTK 3, GStreamer, GLib and their
                dependencies, at exactly the versions bundled.
                Unpack one with:  dpkg-source -x ubuntu/<pkg>/*.dsc
sources.tsv     Those source packages and versions.
files.tsv       Every bundled file, the binary package that ships it and its
                source package.
unresolved.txt  Bundled files no package owns: caches generated at build time
                from the bundled files (GSettings schemas, loader caches).
appimage-tools-apprun-hooks/
                The start-up hooks written by linuxdeploy's GTK and GStreamer
                plugins (MIT), as bundled. The AppImage runtime (MIT) is
                https://github.com/AppImage/type2-runtime, and AppRun.wrapped
                is Tauri's AppRun from https://github.com/tauri-apps/binary-releases
                (tag apprun-old).

Built in docker.io/library/ubuntu:22.04 by packaging/build-appimage.sh.
README
tar -cf "/out/$name.tar" -C /tmp/srctar "$name"
echo "/out/$name.tar ($(du -h "/out/$name.tar" | cut -f1), $(wc -l <"$src/sources.tsv") source packages)"
EOF
