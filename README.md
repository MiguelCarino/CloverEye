# CloverEye

An **unofficial desktop client for 4chan**: boards and threads in a modern
three-pane layout, a thread watcher, filters, and Clip, which fits a video to
the board you are posting to.

CloverEye is not affiliated with, endorsed by or connected to 4chan. The
site's rules apply to everything read and posted through it.

Licence: [AGPL-3.0](LICENSE). Scope and phases: [docs/SCOPE.md](docs/SCOPE.md).

## Status: C0 (gates)

| Part | State |
|---|---|
| Rust fetch layer (`crates/fetch`) | Built and tested: one queue, ≥ 1 s between requests, ≥ 10 s per thread, `If-Modified-Since`/304, back-off on 429/5xx/other errors that waits out `Retry-After` in full |
| ffmpeg check (`crates/ffcheck`) | Built and tested: read-only `-version`/`-encoders`/`-filters` |
| First-time setup (`ui/`) | Runs in a browser with a mock bridge; 8 steps per SCOPE §3.1b |
| Design tokens (`ui/css/tokens.css`) | Dark default, light, follows the system; density; text size |
| Desktop shell (`src-tauri/`) | Release-built and packaged as RPMs for Fedora 44 and 45; launched once on Fedora 45 (setup renders in WebKitGTK), not yet exercised further (see below) |
| Live API probe (`crates/fetch/examples/probe.rs`) | Run once on 4 November 2026: no 429s; results in [docs/C0-PROBE.md](docs/C0-PROBE.md) |

Not done yet (C0 gates in SCOPE §7): the week of normal browsing with zero
429s, WebM playback in WebKitGTK and WKWebView, and the hand-posted
codec/MP4/dimension checks.

## Layout

```
crates/fetch      clovereye-fetch: queue, limits, cache, back-off, API models
crates/ffcheck    clovereye-ffcheck: what the local ffmpeg can do for Clip
ui/               the app's UI: plain HTML/CSS/JS, no build step, no CDN
  js/setup-model.js   setup rules, DOM-free (tested with node --test)
  js/bridge.js        Tauri invoke inside the app, a mock in a browser
src-tauri/        Tauri 2 shell (excluded from the root Cargo workspace)
tests/            node tests for ui/
```

## Build dependencies (Linux, Fedora 44 and 45)

The Rust crates and the UI need only Rust and Node. The desktop shell also
needs the WebKitGTK and GTK 3 development files. Install them yourself; the
project never runs a package manager:

```sh
sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel
```

Package names checked against Fedora 44 and Fedora 45 with
`dnf repoquery --whatprovides 'pkgconfig(webkit2gtk-4.1)'` (and the same for
`gtk+-3.0`, `libsoup-3.0`, `librsvg-2.0`). `javascriptcoregtk4.1-devel`
comes in as a dependency of `webkit2gtk4.1-devel`. TLS uses rustls, so
`openssl-devel` is not needed.

Toolchain used: Rust 1.99 (Fedora's), Node 22, and the Tauri CLI only for
bundling (`cargo install tauri-cli --version '^2'`), which C0 does not need.

## Tests

```sh
CARGO_BUILD_JOBS=4 cargo test     # Rust: fetch limits, models, ffmpeg parsing
node --test tests/*.test.mjs      # UI: setup model, bridge, comment parser, static checks
```

All automated tests use recorded fixtures and a fake clock; none touches the
network. The fixtures and how they were recorded are listed in
`crates/fetch/tests/fixtures/SOURCE.txt` (two GETs, three seconds apart).

## Run the UI in a browser

ES modules need a server (not `file://`):

```sh
python3 -m http.server 7397 --bind 127.0.0.1 --directory ui
# open http://127.0.0.1:7397/
```

In a browser the bridge is a mock: settings live in `localStorage`, the board
list comes from the recorded `ui/data/boards.sample.json`, and the ffmpeg
check returns a canned result matching the Fedora 45 machine CloverEye is
built on. Query parameters exercise the other states:

| Parameter | Effect |
|---|---|
| `?mock-boards=fail` / `fail-once` | Board list fails (always / first try only): Retry and Skip |
| `?mock-ffmpeg=missing` / `partial` / `no-vp9` | ffmpeg absent, optional extras missing, or VP9 missing |
| `?mock-delay=0` | No artificial delay |
| `#setup` | Run setup again after it was finished |

To start over, clear the site data for `127.0.0.1:7397`.

### Browser checks (Playwright)

With the server above running, two scripts drive the UI. Playwright is not a
dependency of this repo; point `PLAYWRIGHT` at an installed copy's
`index.mjs`.

```sh
PLAYWRIGHT=/path/to/playwright/index.mjs node tests/e2e/setup-flow.mjs chromium   # or firefox
PLAYWRIGHT=/path/to/playwright/index.mjs SHOTS_DIR=shots node tests/e2e/layout.mjs chromium
```

`setup-flow.mjs` walks all eight steps with the mouse and again with the
keyboard only (Enter, Esc, arrows, Tab, Space), plus the board-list failure
and missing-ffmpeg states. `layout.mjs` screenshots every step, the dialogs
and the shell at widths 360, 800, 1280 and 1920 in dark and light, and
reports horizontal scroll, off-screen or clipped elements, overlapping
controls and console errors.

## Run the desktop shell

```sh
cd src-tauri
CARGO_BUILD_JOBS=4 cargo run
```

Notes for the first test builds:

- The release build was launched once on Fedora 45 (4 November 2026): the
  window opens with the custom title bar and the setup's first step renders
  with its fonts and icon. Not checked yet: the window controls on the title
  bar, the `ipc:` connection under the page's own CSP (`ui/index.html`
  carries a meta CSP as well as `tauri.conf.json`; if the IPC is blocked,
  drop the meta tag), and that the rules link opens in the system browser.
- `capabilities/default.json` allows only the four app commands
  (`get_settings`, `set_settings`, `check_ffmpeg`, `fetch_boards`), the
  title-bar window controls, and opening `https://www.4chan.org/rules`.
- Settings are JSON in the app config folder for now (SQLite comes in C1).

## Packages (Fedora 44 and 45)

Test RPMs for each release are attached to the GitHub releases:

```sh
sudo dnf install ./clovereye-0.1.0-1.fc45.x86_64.rpm   # or .fc44
```

To build them yourself (results go to `~/.cache/clovereye/packaging`, never
into the repository):

```sh
packaging/build-rpm.sh                 # the Fedora release you are on
packaging/build-in-container.sh 44     # another release, in a podman container
```

`build-rpm.sh` makes the same release build as `cargo tauri build` (the UI
embedded, no dev server) and packages it with `packaging/clovereye.spec`. The
RPM recommends `/usr/bin/ffmpeg`, so Fedora's `ffmpeg-free` and RPM Fusion's
`ffmpeg` both satisfy it.

## Live API probe (C0 gate)

```sh
cargo run -p clovereye-fetch --example probe -- --out results/probe.md
```

At most 8 requests (25 allowed), one queue, ≥ 1 s apart, honest
`User-Agent: CloverEye/0.1.0`: boards, `/g/` catalog twice (the second
conditional), `threads.json`, one live thread twice ≥ 10 s apart, and
`archive.json`. `--thumb` adds one thumbnail request to see whether the
image host answers a polite client or returns 429.

## Rules the client keeps

- At most one request per second for the whole app; thread updates no more
  often than every 10 s; `If-Modified-Since` on every repeat request
  (4chan's published API rules). These are hard limits, not settings.
- Back-off on 429, 5xx, other unexpected statuses (403, 3xx) and network
  errors. A server's `Retry-After` is waited in full (only values over 24 h
  are cut); without one the delay doubles from 2 s, capped at five minutes.
- Redirects are not followed, so no request skips the queue.
- `User-Agent: CloverEye/<version>`. Nothing about the user is sent.
- NSFW boards (`ws_board: 0`) stay hidden until the user opts in with an
  explicit 18+ confirmation.
- No package manager is ever run and no admin rights are asked for; missing
  tools come with a command to copy.

## Third-party files

- Inter (variable), © The Inter Project Authors, SIL OFL 1.1:
  `ui/fonts/Inter-OFL.txt`
- Noto Sans Mono (variable), © The Noto Project Authors, SIL OFL 1.1:
  `ui/fonts/NotoSansMono-OFL.txt`

Both are subset to Latin, Greek and Cyrillic and converted to WOFF2.
