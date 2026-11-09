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
# On an Apple silicon Mac, set PLATFORM=linux/amd64 to build the x86_64 RPM
# (podman machine with Rosetta); without it the container, and the RPM, is aarch64.
set -euo pipefail

rel=${1:?usage: build-in-container.sh <fedora-release> [out-dir]}
repo=$(cd "$(dirname "$0")/.." && pwd)
out=${2:-${XDG_CACHE_HOME:-$HOME/.cache}/clovereye/packaging}
mkdir -p "$out"
command -v podman >/dev/null || { echo "podman is not installed" >&2; exit 1; }

exec podman run --rm -i --security-opt label=disable ${PLATFORM:+--platform "$PLATFORM"} \
    -v "$repo:/src:ro" -v "$out:/out" -v clovereye-cargo-cache:/root/.cargo/registry \
    -e JOBS \
    "registry.fedoraproject.org/fedora:$rel" bash -s <<'EOF'
set -euo pipefail
dnf -y -q install --setopt=install_weak_deps=False \
    cargo rust rpm-build gcc webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel \
    </dev/null >/tmp/dnf.log 2>&1 || { cat /tmp/dnf.log >&2; exit 1; }
# Copy the tree in, minus the two target/ folders. cp, not tar: under Rosetta
# (PLATFORM=linux/amd64 on a Mac) GNU tar cannot stat the shared folder
# ("Function not implemented"), while cp -a reads it fine.
copy_tree() {   # copy_tree <from> <to>: every entry except target/
  mkdir -p "$2"
  for e in "$1"/* "$1"/.[!.]*; do
    [ -e "$e" ] || continue
    case ${e##*/} in
      target) ;;
      src-tauri) copy_tree "$e" "$2/src-tauri" ;;
      *) cp -a "$e" "$2/" ;;
    esac
  done
}
copy_tree /src /build
/build/packaging/build-rpm.sh /out
EOF
