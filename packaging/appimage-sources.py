#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Map every file the AppImage bundles from Ubuntu to its source package.

Runs inside the Ubuntu 22.04 build container (packaging/build-appimage.sh),
after `cargo tauri build`, against the AppDir the bundler left behind:

    appimage-sources.py <AppDir> <out-dir>

Writes to out-dir:
    sources.tsv   source package <TAB> version, one line each, sorted
    files.tsv     AppDir path <TAB> binary package <TAB> source package
    unresolved.txt  AppDir files no package owns (generated caches only)

It reads dpkg's own file lists (/var/lib/dpkg/info/*.list) and asks
dpkg-query for each binary package's source; nothing is downloaded here.
Exits 1 if a shared library or plugin cannot be traced to a package.
"""
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

appdir = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

# Files CloverEye itself puts in the AppDir (its own source is in the tar).
OWN = {"AppRun", "AppRun.wrapped", "CloverEye.desktop", "CloverEye.png", "clovereye.png", ".DirIcon", "usr/bin/clovereye"}
# Caches and indexes the bundler generates at build time from bundled files.
GENERATED = ("gschemas.compiled", "loaders.cache", "immodules.cache", "giomodule.cache")

by_name = defaultdict(list)  # basename -> [(package, full path)]
for lst in Path("/var/lib/dpkg/info").glob("*.list"):
    pkg = lst.stem.split(":")[0]
    for line in lst.read_text(errors="replace").splitlines():
        if line and not line.endswith("/"):
            by_name[os.path.basename(line)].append((pkg, line))


def owner(rel: str):
    """The binary package that ships this AppDir file: same basename, and of
    the candidates the one whose path shares the longest tail."""
    name = os.path.basename(rel)
    cands = by_name.get(name, [])
    if not cands:
        return None
    parts = rel.split("/")

    def tail(full):
        fp = full.split("/")
        n = 0
        while n < min(len(fp), len(parts)) and fp[-1 - n] == parts[-1 - n]:
            n += 1
        return n

    cands.sort(key=lambda c: (-tail(c[1]), c[0]))
    return cands[0][0]


source_of = {}


def source(pkg: str):
    if pkg not in source_of:
        r = subprocess.run(
            ["dpkg-query", "-W", "-f", "${source:Package}\t${source:Version}", pkg],
            capture_output=True, text=True, check=True,
        )
        source_of[pkg] = tuple(r.stdout.strip().split("\t"))
    return source_of[pkg]


rows, unresolved, missing_libs = [], [], []
for f in sorted(p for p in appdir.rglob("*") if p.is_file() or p.is_symlink()):
    rel = f.relative_to(appdir).as_posix()
    if rel in OWN or rel.startswith("apprun-hooks/") or rel.startswith("usr/share/icons/") or rel == "usr/share/applications/CloverEye.desktop":
        continue
    pkg = owner(rel)
    if pkg is None:
        unresolved.append(rel)
        if ".so" in os.path.basename(rel) or "/gstreamer" in rel or rel.endswith("Process"):
            if not rel.endswith(GENERATED):
                missing_libs.append(rel)
        continue
    src, ver = source(pkg)
    rows.append((rel, pkg, src, ver))

sources = sorted({(src, ver) for _, _, src, ver in rows})
(out / "sources.tsv").write_text("".join(f"{s}\t{v}\n" for s, v in sources))
(out / "files.tsv").write_text("".join(f"{r}\t{p}\t{s}\n" for r, p, s, _ in rows))
(out / "unresolved.txt").write_text("".join(f"{u}\n" for u in unresolved))
print(f"{len(rows)} files from {len(sources)} source packages; {len(unresolved)} unresolved")
if missing_libs:
    print("libraries with no owning package:", *missing_libs, sep="\n  ", file=sys.stderr)
    sys.exit(1)
