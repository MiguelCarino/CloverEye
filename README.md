# CloverEye

An **unofficial desktop client for 4chan**: boards and threads in a modern
three-pane layout, a thread watcher, filters, and Clip, which fits a video to
the board you are posting to.

CloverEye is not affiliated with, endorsed by or connected to 4chan. The
site's rules apply to everything read and posted through it.

Licence: [AGPL-3.0](LICENSE). Scope and phases: [docs/SCOPE.md](docs/SCOPE.md).

## Status: reading, watching and the post window

| Part | State |
|---|---|
| Rust fetch layer (`crates/fetch`) | Built and tested: one queue, ≥ 1 s between requests, ≥ 10 s per thread, `If-Modified-Since`/304, back-off on 429/5xx/other errors that waits out `Retry-After` in full |
| ffmpeg check (`crates/ffcheck`) | Built and tested: read-only `-version`/`-encoders`/`-filters` |
| First-time setup (`ui/`) | Runs in a browser with a mock bridge; 7 steps per SCOPE §3.1b (NSFW is only in Settings) |
| Design tokens (`ui/css/tokens.css`, `themes.css`) | Dark default, light, follows the system; Classic and Atrium theme variants; density; text size |
| Settings (`ui/js/settings-view.js`) | Look (theme, density, text size) and Content (NSFW boards, 18+ confirmation); saves as you change it |
| Desktop shell (`src-tauri/`) | Release-built and packaged (Fedora 44/45 RPMs, AppImage); runs on Fedora 45 with the live site |
| Reading (`ui/js/browse.js`, `browse-model.js`) | Board list, catalog (search, sort, refresh) and threads (backlinks, files expand in place, WebM plays inline, updates itself every 10 s or more while open, stops on closed/archived/404) through `fetch_catalog`/`fetch_thread` and the one queue; thumbnails and files load in the webview from the image host. Checked against the live /g/ catalog and a live thread on 4 November 2026 |
| Video | WebM and MP4 play inline (one at a time, volume remembered for the session) and keep playing through thread updates; checked live on /wsg/ in WebKitGTK on 5 November 2026 |
| Hover preview (`ui/js/hover.js`) | Resting the mouse on a thumbnail shows the full image, or plays the video muted, fitted inside the window; Settings → Look turns it off |
| Panes and windows | Up to five panes per window, in one to three rows (the 1/2/3 switch); open a thread beside (the card's button, Ctrl+click, middle-click); each pane can move to a window of its own, which has its own five panes. Windows share one request queue and one settings file (a change in one reaches the others). On a narrow window, tabs switch panes |
| Thread controls and flags | A thread's Update, Watch, Reply and Gallery stay at the top of the pane: scrolling down tucks them away, scrolling up, reaching the end, pointing at the top of the pane or tabbing to them brings them back. Posts show the poster's flag (country flags on /int/, /bant/, /sp/ …; board flags where a board has its own), with its name on hover |
| Gallery | **G** in a thread: every file, one at a time, as large as the window allows; ←/→, J/K, Home/End or the mouse wheel move, **D** saves (Settings → Files folder, else Downloads/CloverEye; the button shows the download running and landing, and saved files get a check in the strip), Esc or G closes |
| Sidebar | Hide or show it from the button left of the title; remembered |
| Favourites | Star boards in All boards |
| Thread watcher | Watch from a thread; the rail lists watched threads with unread counts, 404 and archived marks; polled at the watch interval through the same queue (open threads update themselves). (You)s and notifications are not built yet |
| Posting (`post_agent`, `src/post_agent.js`) | Reply, quote (a post's No.) and New thread open CloverEye's own reply form: name, options, subject, comment with the board's limit, a file (pick, drop or paste; location and camera data stripped from JPEG/PNG first), spoiler, checks against `boards.json` before sending, the site's captcha shown and solved in the form, (You)s remembered and the thread watched. The form resizes from the grip in its top-left corner (drag, or arrow keys on the grip; double-click for the default size; the size is kept). The form minimises to its title bar (which shows a wait counting down, or what the captcha needs), and drafts are saved as they are typed, so they come back after the app is closed (the text only, not the attached file). A wait the site asks for counts down live, and the next captcha comes by itself when it ends. The site's captcha and post endpoints sit behind a Cloudflare check that refuses a plain client (403), so a hidden helper window on the site's own page does what the site's form does; when the site wants its human check (the captcha frame stays silent for a few seconds), that window opens the captcha page as its own page, where the check works as Cloudflare intends, and comes forward for the person to pass; the captcha then lands in the form and the window hides. Closing that window ends the wait with a message. A captcha that has not come after 7 s brings the window forward regardless, and the form has a “Show the site window” button. If the helper's web page dies, the form says so and the page reloads. Helper steps are logged to the terminal (`clovereye post helper: …`); `CLOVEREYE_TRY_CAPTCHA=<board>` asks for one captcha at start and prints what came back (it never posts). The AppImage leaves colour fonts out (its bundled WebKit aborts on COLRv1 colour fonts such as Fedora's emoji), so emoji are black and white there; `CLOVEREYE_COLOR_FONTS=1` keeps them. **Not yet tested with a real post**; the human check was seen live but not passed by the tests. When the site asks for hCaptcha, “Post on the site's page instead” opens the site itself |
| Logo and start-up | An oekaki-style golden clover; a short start-up animation (skipped with reduced motion) |
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

In a browser the bridge is a mock and never contacts the site: every board
shows the synthetic catalog in `ui/data/catalog.sample.json`, threads are
built from it, and files show local pictures. Settings live in `localStorage`, the board
list comes from the recorded `ui/data/boards.sample.json`, and the ffmpeg
check returns a canned result matching the Fedora 45 machine CloverEye is
built on. Query parameters exercise the other states:

| Parameter | Effect |
|---|---|
| `?mock-boards=fail` / `fail-once` | Board list fails (always / first try only): Retry and Skip |
| `?mock-catalog=fail` | Every catalog fails: the error and Try again |
| `?mock-grow` | Every later fetch of a thread adds one reply (for the watcher) |
| `?mock-captcha=wait` / `none` | The captcha asks to wait, or is not needed. The mock captcha's right answer is the 3rd choice, then the 2nd |
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

`setup-flow.mjs` walks all seven steps and Settings with the mouse and
again with the keyboard only (Enter, Esc, arrows, Tab, Space), plus the
board-list failure and missing-ffmpeg states. `layout.mjs` screenshots every step, the dialogs
the shell and Settings (with a few Classic and Atrium themes) at widths
360, 800, 1280 and 1920 in dark and light, and
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

## Packages

Test builds are attached to the GitHub releases:

```sh
sudo dnf install ./clovereye-0.1.0-1.fc45.x86_64.rpm   # Fedora 45 (or .fc44)
chmod +x CloverEye-0.1.0-x86_64.AppImage && ./CloverEye-0.1.0-x86_64.AppImage   # other x86-64 Linux
```

`CloverEye-0.1.0-appimage-sources.tar` next to it is the Corresponding Source
for the AppImage: CloverEye's own source and the Ubuntu 22.04 source package
of every library it bundles (WebKitGTK, GTK 3, GStreamer and their
dependencies, LGPL and others), traced file by file (`files.tsv` inside).

The AppImage is built on Ubuntu 22.04 and needs glibc 2.35 or newer. It
carries its own WebKitGTK and GStreamer (base and good plugins, which
include the WebM demuxer and VP8/VP9 decoders); WebM playback in it is not
tested yet.

To build them yourself (results go to `~/.cache/clovereye/packaging`, never
into the repository):

```sh
packaging/build-rpm.sh                 # the Fedora release you are on
packaging/build-in-container.sh 44     # another release, in a podman container
packaging/build-appimage.sh            # the AppImage + its sources tar, in an Ubuntu 22.04 container
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
- NSFW boards (`ws_board: 0`) stay hidden until the user opts in, in
  Settings → Content, with an explicit 18+ confirmation. Setup never asks.
- No package manager is ever run and no admin rights are asked for; missing
  tools come with a command to copy.

## Third-party files

- Inter (variable), © The Inter Project Authors, SIL OFL 1.1:
  `ui/fonts/Inter-OFL.txt`
- Noto Sans Mono (variable), © The Noto Project Authors, SIL OFL 1.1:
  `ui/fonts/NotoSansMono-OFL.txt`

Both are subset to Latin, Greek and Cyrillic and converted to WOFF2.
