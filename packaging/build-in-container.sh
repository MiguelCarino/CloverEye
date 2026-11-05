#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Run packaging/build-rpm.sh, unchanged, inside a Fedora container, to build
# the RPM for a release other than the host's.
#
# Usage: packaging/build-in-container.sh <fedora-release> [out-dir]
#        packaging/build-in-container.sh 44
# Needs podman. The repository is mounted read-only and copied in (uncommitted
# edits included), so the build never writes into the working tree; SELinux
# labelling is off for the container so the host files keep their labels. Results
# land in out-dir, default $XDG_CACHE_HOME/clovereye/packaging. Cargo's
# download cache lives in the podman volume clovereye-cargo-cache.
set -euo pipefail

rel=${1:?usage: build-in-container.sh <fedora-release> [out-dir]}
repo=$(cd "$(dirname "$0")/.." && pwd)
out=${2:-${XDG_CACHE_HOME:-$HOME/.cache}/clovereye/packaging}
mkdir -p "$out"
command -v podman >/dev/null || { echo "podman is not installed" >&2; exit 1; }

exec podman run --rm -i --security-opt label=disable \
    -v "$repo:/src:ro" -v "$out:/out" -v clovereye-cargo-cache:/root/.cargo/registry \
    -e JOBS \
    "registry.fedoraproject.org/fedora:$rel" bash -s <<'EOF'
set -euo pipefail
dnf -y -q install --setopt=install_weak_deps=False \
    cargo rust rpm-build gcc webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel \
    </dev/null >/tmp/dnf.log 2>&1 || { cat /tmp/dnf.log >&2; exit 1; }
mkdir /build && cd /src && tar --exclude=./target --exclude=./src-tauri/target -cf - . | tar -C /build -xf -
/build/packaging/build-rpm.sh /out
EOF
