# CloverEye: scope for a desktop imageboard client

Rev 2 · 4 November 2026 · status: **approved; all §11 decisions settled by
the owner on 4 November 2026**. Desktop first; the extension waits (D4).

A client for 4chan that reads boards and threads, watches threads, filters
posts, posts replies, and has the Clip video tool built in. Its pitch, in one
line: **drop a video, and it comes out fitting the board you're posting to.**
It ships as a desktop app (Linux, Windows, macOS) and as a browser extension.

It is **not a Carino Systems product** (§2). Clip itself stays a Files mode
(`~/Github/Files/docs/SCOPE-CLIP.md`); this client reuses its pure parts.

---

## 1. Facts this scope rests on (checked 4 November 2026)

| Fact | Consequence |
|---|---|
| The read API (`a.4cdn.org`) only answers browser requests from `boards.4chan.org` (CORS). A request from any other origin gets `access-control-allow-origin: http://boards.4chan.org`. | **A hosted website can't be the web version.** It would need a proxy that relays 4chan's content through a server we run. The web version is a browser extension running on `boards.4chan.org` (§5). |
| `boards.json` gives per-board `max_filesize`, `max_webm_filesize`, `max_webm_duration`, `webm_audio`, `max_comment_chars`, `cooldowns`, `min_image_width/height`, `require_subject`, `ws_board`, `spoilers`, `math_tags`, `code_tags`, `user_ids`, `country_flags`. E.g. /g/ 4 MB · 120 s · no sound; /wsg/ 6 MB · 400 s · sound; /gif/ 4 MB · 300 s · sound. | **Clip presets come live from the board**, not from a hand-kept list. The post form can check every limit before upload. |
| The API sends `Last-Modified` and accepts `If-Modified-Since`; `cache-control: max-age=5`. | Thread updates are conditional requests; most cost a 304. |
| One plain request to the image host (`i.4cdn.org`) got **HTTP 429**. | 4chan's edge rate-limits clients that don't behave like a browser. The fetch layer must be conservative and look like a normal browser (§4.1). This is the biggest unknown and is tested first (C0). |
| 4chan publishes API rules (github.com/4chan/4chan-API): at most 1 request per second, thread updates no more often than every 10 s, use `If-Modified-Since`. | Built into the fetch layer as hard limits, not settings. |

Not confirmed, to check in C0: which video codecs 4chan accepts in WebM
(VP8/VP9 for sure; AV1 unknown), whether MP4 uploads are accepted, the
maximum image dimensions (the community figure is 2048×2048, not in the
API), and the current posting and captcha flow.

## 2. Why it's separate from Carino Systems

- The fleet rule is **no outside requests**; this app is nothing but outside
  requests to one site.
- The content is user-posted, often NSFW, and occasionally illegal. A
  company selling to clinics shouldn't have its name on it.
- "4chan" is someone else's trademark: the product name and icon can't use
  it. "A client for 4chan" in the description is fine (§11, D1).

So, like ButterEye: own repo, own name, own icon, not on the hub, no
`carino.systems` domain, no Carino branding. Licence AGPL-3.0, matching
Files, so Clip code moves between them freely (§11, D2).

## 3. Features

### 3.1 Read (C1)
- **Boards**: list from `boards.json`, favourites pinned. **NSFW boards
  (`ws_board: 0`) are off by default** and appear only after the user opts
  in once in Settings (D6). Links into an NSFW board while it's off show a
  one-line notice with the switch, not the content.
- **Catalog**: grid or list; sort by bump order, reply count, creation, last
  reply; search subject + comment; hide/pin threads.
- **Thread**: full post rendering (greentext, quotes, spoilers, code tags
  where `code_tags`, math via vendored KaTeX where `math_tags`, country/board
  flags, poster IDs where `user_ids`), **backlinks**, quote previews on hover
  (tap on touch), inline image/video expand, auto-update with conditional
  requests (10 s minimum, backing off to 60 s+ when nothing changes), unread
  count, last-read line, deleted posts kept and marked.
- **Media**: hover preview, inline WebM/MP4 with sound control, **gallery
  mode** (every file in the thread, arrow keys), download one / download all
  (original filenames, throttled to the 1 req/s limit).
- **Keyboard**: j/k posts, n/p threads, g gallery, r reply, w watch, all
  listed in one help panel.

### 3.1a Interface: modern, not a 2008 forum skin (C1)

The owner's requirement is that the UI is modern. Concretely:

- **Own design system**, not Carino's. Tokens on `:root` (colour, radius,
  spacing, type scale), **dark by default**, light theme, follows the OS
  setting. One accent colour; board identity through a small coloured tag,
  not full re-skins. Fonts self-hosted (a variable sans for UI, a mono for
  code tags).
- **Theme variants** (owner decision, 4 November 2026), all on the same
  tokens (`ui/css/themes.css`): **Classic**, the site's own board styles
  (Yotsuba, Yotsuba B, Futaba, Burichan, Tomorrow, Photon), and **Atrium**,
  the desktop themes of the owner's Atrium setup (Cyberpunk, Matrix, Aero
  Glass, Windows 95, Lo-fi, Luna, Moe, Orbit, Orchard, Orchard Dark).
- **Logo**: a golden four-leaf clover with a dark centre (owner decision,
  4 November 2026). Gold, never green.
- **Three-pane layout** on a wide window: left rail (favourite boards,
  watcher with unread badges), centre (catalog or thread), right panel
  (media viewer / Clip / reply form) that slides in when needed. Collapses to
  one pane with a back stack on a narrow window.
- **Catalog as cards**: a masonry grid of thumbnails with subject, reply and
  image counts, and a "new since last visit" dot. Hover shows the full OP.
- **Thread as a clean reading column**: max ~72-character lines, posts as
  quiet cards, quotes as inline chips that preview on hover, images as
  rounded thumbnails that expand in place, media in a lightbox with
  filmstrip.
- **Command palette** (Ctrl/⌘+K): jump to a board, thread number, watched
  thread, setting or action. Every action has a key; one help sheet lists them.
- **Fast by construction**: virtualized lists (a 1000-post thread scrolls at
  60 fps), skeleton placeholders instead of spinners, optimistic UI on watch
  and hide, images decoded off the main thread.
- **Motion with restraint**: 150–200 ms transitions for panels and new posts
  sliding in on update; all of it off under `prefers-reduced-motion`.
- **Native window feel**: custom title bar with the board/thread title and
  window controls (Tauri `decorations: false`), system notifications, tray
  icon with the (You) count.
- **Density toggle** (comfortable / compact) and a text-size setting.
- Verified like fleet UI: window widths 800, 1280 and 1920, both themes, no
  horizontal scroll, no console errors, keyboard-only pass.

### 3.1b First-time setup (C0 builds it, C1 wires it)

Shown on first launch, before any request to the site. Full-window, one
step per screen, a progress row on top, **Back / Next / Skip setup** on every
step, keyboard-only works (Enter, Esc, arrows). Every answer is changeable
later in Settings, and **Settings → Run setup again** reopens it.

1. **Welcome**: what CloverEye is, and that it's an unofficial client, not
   affiliated with or endorsed by 4chan. A link to the site's rules. No
   network request has been made yet, and the screen says so.
2. **Look**: theme (System / Dark / Light, the Classic and the Atrium
   variants), density (Comfortable / Compact), text size, previewed live on
   a sample thread built from local data.
3. **Boards**: pick favourites from a grid (the board list is the first
   network request, made only when this step opens; if it fails, the step
   offers Retry or Skip, and favourites can be picked later).
4. **Video (Clip)**: checks ffmpeg and its encoders (libvpx-vp9, libsvtav1,
   libopus, libass, libplacebo) and shows a ✓/✗ row each. When something is
   missing, it shows the install command for this OS to copy. On Fedora it
   reads which package is installed (read-only `rpm -q`): Fedora's
   `ffmpeg-free` first, then RPM Fusion's `ffmpeg`, and the command fits that
   (install `ffmpeg-free`, or swap to RPM Fusion's fuller build). The app
   never runs a package manager or asks for admin rights. Clip is disabled
   with a reason until the check passes; everything else works.
5. **Watching**: notifications for replies to your posts (on/off; asks
   the OS for permission only if on), keep running in the tray when the
   window closes (on/off), and how often watched threads update (10 s
   minimum, the API rule).
6. **Files and privacy**: download folder; "strip location and camera data
   from images before posting" (on by default); media cache in memory only
   (default) or a size-capped temp cache.
7. **Done**: a summary of the choices with links to change each, then
   opens the first favourite board (or the board list).

Stored in the app's settings DB with a `setupVersion`; a later release
that adds a step shows only the new steps, not the whole flow.

### 3.2 Track (C2)
- **(You)s**: posts made from the client are remembered; replies to them are
  highlighted and counted.
- **Thread watcher**: a sidebar of watched threads with unread and (You)
  counts, polled within the API limits, marked 404/archived when they die
  (with `archive.json` links where the board is archived).
- **Desktop notifications** for replies to (You) (desktop app only).
- **Filters**: by regex on comment, subject, name, tripcode, ID, filename, or
  by file MD5; per board or global; **hide** or **highlight**; import/export
  as JSON.

### 3.3 Post (C4)
- Reply and new-thread forms (quick reply floats over the thread).
- **Captcha: the user solves 4chan's own captcha** in an embedded view of
  4chan's page. The client never solves, bypasses or outsources it.
- 4chan Pass login (the user's own cookie, kept in the OS keychain).
- **Pre-flight checks from `boards.json`**: file size, WebM size/length/sound,
  minimum dimensions, comment length, required subject, and cooldown
  countdowns, all shown before posting so a post doesn't bounce.
- **Clean images before upload** (Files' scrub logic: strip EXIF/GPS from
  JPEG, text chunks from PNG), on by default with a one-line report.

### 3.4 Clip, built in (C3)
- Drop or paste a video onto the reply form, or open Clip from the toolbar.
- The preset is **this board**: limit = `max_webm_filesize`, sound only if
  `webm_audio`, length ≤ `max_webm_duration`, longest side ≤ 2048 (if C0
  confirms it). The Clip editor (trim, crop, segments, subtitles, HDR →
  SDR) is the same as in Files.
- Output attaches straight to the post.
- **Engine per platform**:
  - **Desktop: native ffmpeg** (libvpx-vp9 two-pass, SVT-AV1, libopus,
    **libass**). Two-pass rate control lands within ~1% of the target in one
    go and looks better per byte than browser encoders. This is where "best
    WebM tool" is actually won.
  - **Extension: WebCodecs + JASSUB**, exactly as in Files.
  - Both sit behind one interface (`plan → bytes`) and share the pure
    `fit.js` controller and quality warning.

## 4. Desktop app

### 4.1 Architecture
- **Tauri 2** (Rust core, system webview, small installer). The core does
  all networking, so CORS doesn't apply; the UI is the same plain HTML/JS
  (no build step) as the extension.
- **Fetch layer (Rust)**: one queue for the whole app, ≤ 1 req/s, conditional
  requests, 10 s minimum per thread, exponential back-off on 429/5xx (and on
  any other unexpected status), `Retry-After` waited in full, no redirects
  followed, no parallel bursts. One generic client name in the UA; never the
  user's email or identity.
  *Decided in C0 (4 Nov 2026):* the JSON path sends the honest
  `User-Agent: CloverEye/<version>` and **no cookie jar**, instead of a
  browser User-Agent and cookies. The live probe got no 429 with it; images
  load in the webview, which has its own browser UA and cookies. See
  [C0-PROBE.md](C0-PROBE.md). Revisit only if the week-long C0 gate shows
  429s or an edge challenge on the JSON path; a 4chan Pass (C4) would add
  its own cookie then.
- **ffmpeg**: system ffmpeg on Linux (Fedora's has libvpx, SVT-AV1, libass,
  libopus); a bundled build on Windows and macOS, run as a separate process.
- **Storage**: SQLite for watched threads, (You)s, filters and settings.
- **Webviews**: WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows.
  Media playback relies on them: WebM plays through GStreamer on Linux.
  Safari/WKWebView WebM playback gets checked on the owner's Mac (C0); if it
  can't play WebM, the macOS build decodes through ffmpeg to the player.

### 4.2 Media cache and legal safety
- Thumbnails and viewed media are cached **in memory and a size-capped temp
  cache cleared on exit**, not kept on disk.
- Files reach the user's disk only by an explicit download.
- When a post or file is deleted upstream, its cached copy is dropped on the
  next update.
- No full-board scraping, no "download every thread" mode.

### 4.3 Packaging (C6)
- Linux: RPM (Fedora first, matching ButterEye's pipeline) and an AppImage or
  Flatpak.
- Windows: an installer from CI, tested under Wine like ButterEye.
- macOS: an **unsigned** DMG for now (D5). Gatekeeper blocks it on first
  launch; the README says to right-click → Open (or clear the quarantine
  flag). Signing and notarization ($99/year Apple Developer account) wait
  until there's a reason to distribute it.
- No app-store builds. Mobile is out of scope (good Android clients exist).

## 5. The web version: a browser extension

- Runs on `boards.4chan.org` as a content script, so API requests are
  same-origin and posting uses the page's own captcha and cookies.
- Chrome and Firefox first. Safari later, via Apple's converter, only if the
  Mac test shows WebM encoding works there (the Clip rule: WebM or nothing).
- Same UI modules as the desktop app; Clip runs on WebCodecs + JASSUB.
- Distribution: the Chrome Web Store and Firefox Add-ons. Review risk is
  moderate (a site-modifying extension for an NSFW site), so also offer a
  signed `.xpi` and an unpacked zip from GitHub releases.
- Overlap: 4chan X already does most of §3.1–3.2 in the browser. The
  extension is only worth it because of Clip-to-post and a shared UI with the
  desktop app. If it slips, ship desktop alone (§11, D4).

## 6. Not doing

- A hosted website or proxy (§1).
- Captcha solving or outsourcing, ban/cooldown evasion, proxy/VPN rotation,
  multiple identities, scheduled or automated posting. The client posts one
  human post at a time.
- Archiving or mirroring boards.
- Mobile apps, app-store builds.
- Other imageboard engines in v1 (the fetch and render layers are kept
  site-agnostic so a second site could be added later).

## 7. Phases

| Phase | Delivers | Done when |
|---|---|---|
| **C0 · Gates** | First-time setup (§3.1b) and design tokens, runnable in a browser with a mock bridge; Tauri skeleton (compiles once `webkit2gtk4.1-devel` and `gtk3-devel` are installed); Rust fetch layer with limits; measure whether the image host still returns 429 to a polite client; WebM playback in WebKitGTK and WKWebView; confirm codecs/MP4/dimension limits by posting test files to a test board by hand; repo, name, licence | A week of normal browsing with zero 429s, or a documented answer to the 429 problem |
| **C1 · Read** | Design tokens + three-pane shell (§3.1a), command palette, boards, catalog, thread, media, gallery, keyboard | Usable as a daily reader on Linux; UI checks in §3.1a pass |
| **C2 · Track** | (You)s, watcher, notifications, filters | Watcher survives a day open with no rate-limit hits |
| **C3 · Clip** | ffmpeg engine, board-driven presets, Clip editor shared with Files | Fixture suite (Clip §8): ≤ limit 100%, median ≥ 98% |
| **C4 · Post** | Forms, captcha view, Pass, pre-flight checks, image cleaning | Real posts on a test board from Linux, Windows (Wine) and macOS |
| **C5 · Extension** | Chrome + Firefox extension from the same UI | Store submission or release zip |
| **C6 · Ship** | RPM, Windows installer, DMG, update channel | Installs clean on a fresh VM per platform |

**Order with Files:** Clip P0–P2 in Files go first. That builds `fit.js`,
the editor and the WebCodecs engine. C0–C2 can run alongside, since they
share no code with Clip. C3 then reuses the editor and adds the ffmpeg
engine.

## 8. Risks

| Risk | Likelihood | Answer |
|---|---|---|
| 4chan's edge blocks or rate-limits the desktop client | Medium (seen once already) | C0 gate; polite fetch layer; the extension path is immune because it runs in the real page |
| Posting or captcha flow changes and breaks posting | High over time | Posting runs inside an embedded 4chan page, so most changes don't touch our code; keep the post code path small |
| Store rejects the extension | Medium | GitHub releases as the fallback |
| Illegal content in cache | Low but serious | §4.2: memory/temp-only cache, deleted-on-upstream-delete, no scraping |
| Trademark complaint | Low | No "4chan" in name or icon |
| Scope creep into a 4chan X clone | High | The Clip-to-post flow is the product; §3 is the whole v1 list |

## 9. Tests

- Rust: fetch-layer limits (fake clock), back-off, conditional requests.
- JS: post rendering (greentext, quotes, spoilers, code, math, flags),
  backlinks, filters, pre-flight checks against recorded `boards.json` copies.
- Recorded API fixtures, not live requests, in all automated tests.
- Clip: the Files fixture suite, run against both engines.
- Playwright smoke on the extension against a saved copy of a thread page.

## 10. Reused from the fleet

- Clip: `fit.js`, presets schema, quality warning, editor, JASSUB path.
- Files: `scrub.js` (image cleaning before upload), `detect.js`.
- ButterEye: RPM spec pattern, Windows installer + Wine test pattern.
- Not reused: Carino navbar, theme, fonts or marks (§2).

## 11. Decisions (settled 4 November 2026)

| # | Question | Decision |
|---|---|---|
| D1 | Name | **CloverEye** (repo and folder `CloverEye`) |
| D2 | Licence | AGPL-3.0, like Files |
| D3 | Desktop stack | Tauri 2 |
| D4 | Extension | Desktop first; the extension (C5) only after C0–C4 |
| D5 | Apple Developer account | Not now; unsigned macOS build |
| D6 | NSFW boards | Off by default, opt-in in Settings |
| D7 | UI | Modern, per §3.1a |

Name note: "Clover" was also the name of a well-known open-source Android
4chan client (now discontinued, continued by forks), and the clover is 4chan's
logo motif. CloverEye is distinct enough as a name, but the icon should be an
original mark (no four-leaf clover in 4chan's green) to stay clear of their
logo.
