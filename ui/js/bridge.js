// The UI's only door to the outside. Inside the desktop app it calls the
// Rust core through Tauri's `invoke`; in a plain browser it is a mock so the
// UI can be built and checked without the app (settings in localStorage,
// boards from the recorded fixture, a synthetic catalog, a canned ffmpeg
// check, local pictures instead of the image host).

import { catalogThreads, threadTitle } from './browse-model.js';
import { addSample, emptyBoardStats, pruneBoardStats, DAY_MS } from './stats-model.js';
import { emptyMine } from './my-stats-model.js';

const STORAGE_KEY = 'clovereye.settings';
const SAVED_KEY = 'clovereye.saved';
/** The mock's stats files (the app keeps them in its data folder). */
const STATS_KEY = 'clovereye.stats.';
const STATS_KINDS = Object.freeze(['boards', 'mine']);
const MOCK_SAVED_DIR = 'Downloads/CloverEye/Saved threads';
const MEDIA_BASE = 'https://i.4cdn.org';
const FLAG_BASE = 'https://s.4cdn.org/image';

/**
 * A post's flag, as the site shows it: a country flag (/int/, /sp/, /pol/,
 * /bant/ ...: post.country) or a board's own flag (post.board_flag).
 * Returns { src, code, title } or null; src is null when pictures are off.
 */
export function postFlag(board, post, pictures = true) {
  const okCode = (c) => typeof c === 'string' && /^[A-Za-z0-9_-]{1,12}$/.test(c);
  const okBoard = /^[a-z0-9]{1,10}$/.test(String(board || ''));
  if (okCode(post?.country)) {
    const code = post.country.toLowerCase();
    return { src: pictures ? `${FLAG_BASE}/country/${code}.gif` : null, code: post.country, title: String(post.country_name || post.country) };
  }
  if (okCode(post?.board_flag) && okBoard) {
    const code = post.board_flag.toLowerCase();
    return { src: pictures ? `${FLAG_BASE}/flags/${board}/${code}.gif` : null, code: post.board_flag, title: String(post.flag_name || post.board_flag) };
  }
  return null;
}
const MOCK_THUMBS = Object.freeze(['assets/sample-bench.svg', 'assets/sample-hook.svg']);

/** What `check_ffmpeg` reports on the machine CloverEye was built on
 *  (Fedora 45, ffmpeg 9.0.2 with every encoder and filter present). */
export const CANNED_FFMPEG = Object.freeze({
  found: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  os: 'linux',
  distro: 'fedora',
  encoders: { libvpx_vp9: true, libsvtav1: true, libopus: true },
  filters: { ass: true, subtitles: true, libplacebo: true },
  package: Object.freeze({ name: 'ffmpeg', version: '9.0.2', vendor: 'RPM Fusion', source: 'rpmfusion' }),
});

const MOCK_FFMPEG = {
  ok: CANNED_FFMPEG,
  missing: { ...CANNED_FFMPEG, found: false, path: null, version: null, encoders: {}, filters: {}, package: null },
  partial: {
    ...CANNED_FFMPEG,
    package: { name: 'ffmpeg-free', version: '8.1.3', vendor: 'Fedora Project', source: 'fedora' },
    encoders: { libvpx_vp9: true, libsvtav1: false, libopus: true },
    filters: { ass: true, subtitles: true, libplacebo: false },
  },
  'no-vp9': { ...CANNED_FFMPEG, encoders: { libvpx_vp9: false, libsvtav1: true, libopus: true } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------- the mock's live catalog
// The mock's catalog moves with the clock, so the Stats pane has rates to
// show: each board gets its own pace (a few to about forty posts a minute,
// busier in the middle of the day), new threads now and then, and one
// thread at a time gathering the replies. The same timeline seeds a day of
// samples with ?mock-stats.

const MOCK_EPOCH = Date.UTC(2026, 0, 1);
const MOCK_BASE_NO = 500385; // the fixture's highest post number
const mockHash = (s) => [...String(s)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
/** A board's average posts a minute in the mock (2 to 39). */
export const mockPpm = (board) => 2 + (mockHash(board) % 38);
/** The highest post number of `board` at `ms`: always rising, faster by day. */
export function mockMaxNo(board, ms) {
  const t = (ms - MOCK_EPOCH) / 60_000;
  const day = 1440;
  return MOCK_BASE_NO + Math.floor(mockPpm(board) * (t + (day / (2 * Math.PI)) * 0.6 * Math.sin((2 * Math.PI * t) / day)));
}
const mockThreadEvery = (board) => 60 / Math.max(1, Math.round(mockPpm(board) / 4)); // minutes

/** The fixture's catalog as `board` looks at `ms`: up to three new threads
 *  on top (after the stickies) and the busy thread's newest reply. */
export function liveCatalog(fixture, board, ms) {
  const cat = structuredClone(fixture);
  const page = cat[0];
  if (!page?.threads?.length) return cat;
  const t = (ms - MOCK_EPOCH) / 60_000;
  const every = mockThreadEvery(board);
  const k = Math.floor(t / every);
  const fresh = [k, k - 1, k - 2].map((i) => {
    const at = MOCK_EPOCH + i * every * 60_000;
    return { no: mockMaxNo(board, at) - 1, now: '', name: 'Anonymous', com: '', time: Math.floor(at / 1000), resto: 0, replies: Math.min(40, Math.floor((t - i * every) / 3)), images: 0 };
  });
  const plain = page.threads.filter((x) => !x.sticky);
  const hot = plain[Math.floor(t / 30) % plain.length];
  if (hot) {
    hot.replies = (hot.replies || 0) + 1 + Math.floor((t % 30) * mockPpm(board) * 0.25);
    hot.last_replies = [...(hot.last_replies || []).slice(-4), { no: mockMaxNo(board, ms), now: '', name: 'Anonymous', resto: hot.no, time: Math.floor(ms / 1000) }];
  }
  const stickies = page.threads.filter((x) => x.sticky);
  page.threads = [...stickies, ...fresh, ...plain];
  return cat;
}

/** A day of board samples every 5 minutes, for ?mock-stats. */
export function seedBoardStats(fixture, now, boards = ['g', 'v', 'a', 'tv', 'diy', 'sci', 'ck', 'fit']) {
  let store = emptyBoardStats();
  for (const b of boards) {
    for (let at = now - DAY_MS + 5 * 60_000; at < now - 60_000; at += 5 * 60_000) {
      // a gap of two hours on one board, to see the line break
      if (b === 'tv' && at > now - 9 * 3_600_000 && at < now - 7 * 3_600_000) continue;
      store = addSample(store, b, catalogThreads(liveCatalog(fixture, b, at)), at, { title: (op) => threadTitle(op, 60) }).store;
    }
  }
  return pruneBoardStats(store, now);
}

/** Thirty days of made-up counts for the You tab, for ?mock-stats. */
export function seedMine(now) {
  const mine = { ...emptyMine(), since: now - 30 * DAY_MS };
  for (let i = 0; i < 30; i++) {
    const d = new Date(now - i * DAY_MS);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const h = mockHash(key);
    if (h % 7 === 0) continue; // a day off now and then
    const time = 600 + (h % 7200);
    mine.days[key] = {
      time,
      threads: 3 + (h % 25),
      read: 40 + (h % 900),
      posts: h % 6,
      replies: h % 4,
      files: 5 + (h % 120),
      saved: h % 9 === 0 ? 1 : 0,
      boards: { g: { time: Math.round(time * 0.5), threads: 2 + (h % 9) }, v: { time: Math.round(time * 0.3), threads: 1 + (h % 6) }, diy: { time: Math.round(time * 0.2), threads: h % 4 } },
    };
  }
  return mine;
}

/** Returns window.localStorage if it can be used, else null. */
export function safeStorage(win) {
  try {
    const s = win && win.localStorage;
    if (!s) return null;
    const k = '__clovereye_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

/**
 * @param {object} env
 * @param {object} [env.tauri]  window.__TAURI__ when inside the app
 * @param {Storage|null} [env.storage]
 * @param {Function} [env.fetchImpl]  fetch, for the mock's fixture
 * @param {object} [env.mock]  { boards: 'ok'|'fail'|'fail-once', ffmpeg: 'ok'|'missing'|'partial'|'no-vp9', delayMs, notify }
 */
export function createBridge({ tauri = null, storage = null, fetchImpl = null, mock = {} } = {}) {
  let siteRequests = 0;
  const invoke = tauri?.core?.invoke;

  if (typeof invoke === 'function') {
    const win = () => tauri.window?.getCurrentWindow?.();
    return {
      kind: 'tauri',
      siteRequests: () => siteRequests,
      async getSettings() {
        return (await invoke('get_settings')) ?? null;
      },
      async setSettings(settings) {
        await invoke('set_settings', { settings });
        return true;
      },
      async fetchBoards() {
        siteRequests += 1;
        return invoke('fetch_boards');
      },
      async checkFfmpeg() {
        return invoke('check_ffmpeg');
      },
      /** { freshness: 'new'|'not-modified'|'throttled', data } or throws
       *  Error('not-found') / the fetch layer's message. */
      async fetchCatalog(board) {
        siteRequests += 1;
        return invoke('fetch_catalog', { board });
      },
      async fetchThread(board, no) {
        siteRequests += 1;
        return invoke('fetch_thread', { board, no });
      },
      /** Posting happens on the site's own page (SCOPE §3.3): a separate
       *  window with the thread (or the board, for a new thread) and its
       *  reply form, where the person solves the site's captcha. */
      async openPost(board, thread = null, quote = null) {
        await invoke('open_post_window', { board, thread, quote });
        return { mock: false };
      },
      /** The site's captcha for this board/thread, fetched by the post
       *  helper (src/post_agent.js). Throws 'check-needed' when the site
       *  wants a browser check first (the helper window is then shown). */
      async captcha(board, thread = 0) {
        siteRequests += 1;
        return invoke('post_agent', { op: 'captcha', args: { board, thread } });
      },
      /** Brings the helper window (the site's check) forward. */
      async showSiteWindow() {
        return invoke('post_agent_show');
      },
      /** Sends a post through the helper: { status, text } from the site. */
      async submitPost(board, fields, file = null) {
        siteRequests += 1;
        return invoke('post_agent', { op: 'post', args: { board, fields, file } });
      },
      async openWindow(panes) {
        return invoke('open_window', { panes });
      },
      async saveMedia(url, name, dir = '') {
        siteRequests += 1;
        return invoke('save_media', { url, name, dir: dir || null });
      },
      // Saved threads (src-tauri/src/offline.rs): `dir` is Settings → Files →
      // Saved threads ('' = Downloads/CloverEye/Saved threads).
      async offlineList(dir = '') {
        return invoke('offline_list', { dir: dir || null });
      },
      /** { thread, folder, title, savedAt, files, thumbs } or Error('not-saved'). */
      async offlineRead(dir, board, no) {
        return invoke('offline_read', { dir: dir || null, board, no });
      },
      /** Writes thread.json (the posts the queue already loaded). */
      async offlineWriteThread(dir, board, no, title, thread) {
        return invoke('offline_write_thread', { dir: dir || null, board, no, title, thread });
      },
      /** One file or thumbnail from the image host: { status: 'saved'|'skipped' }. */
      async offlineFetchFile(dir, board, no, job) {
        siteRequests += 1;
        return invoke('offline_fetch_file', { dir: dir || null, board, no, tim: job.tim, ext: job.ext, kind: job.kind, size: job.size || null });
      },
      async offlineDelete(dir, board, no) {
        return invoke('offline_delete', { dir: dir || null, board, no });
      },
      /** A saved file's URL on the app's own scheme (offline-model.js savedFilePath). */
      savedFileUrl: (path) =>
        typeof tauri.core?.convertFileSrc === 'function' ? tauri.core.convertFileSrc(path, 'cesaved') : `cesaved://localhost/${encodeURIComponent(path)}`,
      /** Download all files: one file, through the same ≥ 1 s gate. */
      async downloadFile(url, name, dir = '', size = 0) {
        siteRequests += 1;
        return invoke('download_file', { url, name, dir: dir || null, size: size || null });
      },
      /** Another window saved new settings. */
      onSettingsChanged(cb) {
        tauri.event?.listen?.('settings-changed', (e) => cb(e.payload));
      },
      // Stats (src-tauri/src/stats.rs): 'boards' (activity samples) or
      // 'mine' (your own counts), each a file in the app's data folder.
      /** The stored stats object (with its `rev`), or null. */
      async statsRead(kind) {
        return (await invoke('stats_read', { kind })) ?? null;
      },
      /** Stores `data` if the file is still at `rev`; resolves the new rev,
       *  or throws Error('stats-conflict') when another window wrote first. */
      async statsWrite(kind, data, rev) {
        return invoke('stats_write', { kind, data, rev });
      },
      /** Requests to the site waiting or under way, in every window. */
      async fetchBusy() {
        try {
          return Number(await invoke('fetch_busy')) || 0;
        } catch {
          return 0;
        }
      },
      // Media loads in the webview straight from the image host (SCOPE §4.1).
      thumbUrl: (board, post) => (post.tim ? `${MEDIA_BASE}/${board}/${post.tim}s.jpg` : null),
      flag: (board, post) => postFlag(board, post, true),
      mediaUrl: (board, post) => (post.tim && post.ext ? `${MEDIA_BASE}/${board}/${post.tim}${post.ext}` : null),
      // Native notifications arrive with the tray in C2; until then the
      // switch is stored and the OS is asked when the feature lands.
      async requestNotificationPermission() {
        return 'later';
      },
      async openExternal(url) {
        await invoke('plugin:opener|open_url', { url });
      },
      /** A link from a post (ui/js/link-model.js): any http or https
       *  address, in the system browser; the app checks the scheme again. */
      async openLink(url) {
        await invoke('open_link', { url });
      },
      window: {
        available: Boolean(tauri.window?.getCurrentWindow),
        minimize: () => win()?.minimize(),
        toggleMaximize: () => win()?.toggleMaximize(),
        close: () => win()?.close(),
        /** The native title (task bar, window switcher); the drawn title
         *  bar is set by the page. */
        setTitle: (title) => win()?.setTitle(title)?.catch?.(() => {}),
      },
    };
  }

  // ------------------------------------------------------------ browser mock
  let memory = null; // used when storage is missing or throws
  const delay = Number.isFinite(mock.delayMs) ? mock.delayMs : 350;
  let boardAttempts = 0;
  let catalogCache = null;
  const threadFetches = new Map();
  let mockPostNo = 990000;
  let inflight = 0; // the mock's requests under way, for fetchBusy
  const counted = async (job) => {
    inflight += 1;
    try {
      return await job();
    } finally {
      inflight -= 1;
    }
  };
  let statsMemory = {};
  const seeded = new Set();
  const readStats = (kind) => {
    try {
      const raw = storage ? storage.getItem(STATS_KEY + kind) : null;
      if (raw != null) return JSON.parse(raw);
    } catch {
      /* unreadable: memory */
    }
    return statsMemory[kind] ? JSON.parse(statsMemory[kind]) : null;
  };
  const keepStats = (kind, data) => {
    const json = JSON.stringify(data);
    statsMemory[kind] = json;
    try {
      storage?.setItem(STATS_KEY + kind, json);
    } catch {
      /* kept in memory for this session */
    }
  };
  // saved threads ("board/no" → { board, no, title, savedAt, thread, files, thumbs })
  let savedMemory = null;
  const mockSaved = () => {
    if (savedMemory) return savedMemory;
    savedMemory = new Map();
    try {
      const raw = storage ? storage.getItem(SAVED_KEY) : null;
      for (const e of raw ? JSON.parse(raw) : []) if (e?.board && e?.no && e?.thread) savedMemory.set(`${e.board}/${e.no}`, e);
    } catch {
      /* unreadable: start empty */
    }
    return savedMemory;
  };
  const keepSaved = (store) => {
    try {
      storage?.setItem(SAVED_KEY, JSON.stringify([...store.values()]));
    } catch {
      /* kept in memory for this session */
    }
  };
  const mockCatalog = async () => {
    if (!catalogCache) {
      if (typeof fetchImpl !== 'function') throw new Error('No fixture loader in this environment.');
      const res = await fetchImpl('data/catalog.sample.json');
      if (!res.ok) throw new Error(`Catalog fixture: HTTP ${res.status}`);
      catalogCache = await res.json();
    }
    return structuredClone(catalogCache);
  };

  return {
    kind: 'mock',
    siteRequests: () => siteRequests,
    async getSettings() {
      try {
        const raw = storage ? storage.getItem(STORAGE_KEY) : null;
        if (raw != null) return JSON.parse(raw);
      } catch {
        /* unreadable or blocked storage: fall back to memory */
      }
      return memory ? JSON.parse(memory) : null;
    },
    async setSettings(settings) {
      const json = JSON.stringify(settings);
      memory = json;
      try {
        storage?.setItem(STORAGE_KEY, json);
      } catch {
        /* kept in memory for this session */
      }
      return true;
    },
    async fetchBoards() {
      siteRequests += 1;
      boardAttempts += 1;
      await counted(() => sleep(delay));
      const mode = mock.boards || 'ok';
      if (mode === 'fail' || (mode === 'fail-once' && boardAttempts === 1)) {
        throw new Error('Could not reach the board list (mock failure).');
      }
      if (typeof fetchImpl !== 'function') throw new Error('No fixture loader in this environment.');
      const res = await fetchImpl('data/boards.sample.json');
      if (!res.ok) throw new Error(`Board list fixture: HTTP ${res.status}`);
      return res.json();
    },
    async checkFfmpeg() {
      await sleep(Math.min(delay, 250));
      return structuredClone(MOCK_FFMPEG[mock.ffmpeg] || MOCK_FFMPEG.ok);
    },
    // The mock serves one synthetic catalog (ui/data/catalog.sample.json)
    // for every board, moving with the clock (liveCatalog), and builds
    // threads from its OPs and last replies.
    async fetchCatalog(board) {
      siteRequests += 1;
      await counted(() => sleep(delay));
      if (mock.catalog === 'fail') throw new Error('Could not reach the catalog (mock failure).');
      return { freshness: 'new', data: liveCatalog(await mockCatalog(), board, Date.now()) };
    },
    async fetchThread(board, no) {
      siteRequests += 1;
      await counted(() => sleep(delay));
      const cat = await mockCatalog();
      const op =
        cat.flatMap((p) => p.threads).find((t) => t.no === Number(no)) ||
        // a thread the live catalog made up: just its opening post
        liveCatalog(cat, board, Date.now())[0]?.threads.find((t) => t.no === Number(no) && !t.last_replies);
      if (!op) throw new Error('not-found');
      const { last_replies: replies = [], omitted_posts: _a, omitted_images: _b, last_modified: _c, ...first } = op;
      // ?mock-grow: every later fetch of the same thread brings one new reply.
      const n = (threadFetches.get(op.no) || 0) + 1;
      threadFetches.set(op.no, n);
      // flags, as /int/ (country) and /bant/ (board flags) send them
      replies.forEach((r, i) => {
        if (i === 0) Object.assign(r, { country: 'NZ', country_name: 'New Zealand' });
        if (i === 1) Object.assign(r, { board_flag: 'TM', flag_name: 'Templar' });
      });
      // poster IDs, as boards with user_ids send them (the OP posts again)
      const MOCK_IDS = ['Ab3dE9xQ', 'k2LmP0aZ', 'Zz81qRw5'];
      first.id = MOCK_IDS[0];
      replies.forEach((r, i) => (r.id = MOCK_IDS[i % MOCK_IDS.length]));
      const grown = mock.grow
        ? Array.from({ length: n - 1 }, (_, i) => ({ no: op.no + 900000 + i, resto: op.no, now: '', time: op.time + i + 1, name: 'Anonymous', id: MOCK_IDS[(i + 1) % MOCK_IDS.length], com: `New reply ${i + 1}` }))
        : [];
      // ?mock-cross: one more reply quoting another thread's post, a thread
      // that is gone and a dead link (for cross-thread quotes and archives).
      const others = cat.flatMap((p) => p.threads).filter((t) => t.no !== op.no);
      const other = others[0];
      const cross = mock.cross && other
        ? [{
            no: op.no + 800000,
            resto: op.no,
            now: '',
            time: op.time + 1,
            name: 'Anonymous',
            com: `<a href="/${board}/thread/${other.no}#p${other.no}" class="quotelink">&gt;&gt;&gt;/${board}/${other.no}</a><br>Another thread above.<br><a href="/${board}/thread/1#p2" class="quotelink">&gt;&gt;2</a><br>A thread that is gone.<br><span class="deadlink">&gt;&gt;${op.no - 1}</span><br>A post that is gone.`,
          }]
        : [];
      // ?mock-links: one more reply with web addresses (link-model.js):
      // embeddable ones, plain ones, one split by <wbr>, and ones that must
      // stay text. Written without a scheme; a bare www. or domain/path is
      // taken as https.
      const links = mock.links
        ? [{
            no: op.no + 700000,
            resto: op.no,
            now: '',
            time: op.time + 2,
            name: 'Anonymous',
            // each line in a <span>: post text, not UI text to translate
            com: [
              '<span>Video: www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=42 and youtu.be/dQw4w9WgXcQ</span>',
              '<span>A short: www.youtube.com/shorts/dQw4w9WgXcQ</span>',
              '<span>vimeo.com/76979871 and streamable.com/moo2x</span>',
              '<span>Track: soundcloud.com/forss/flickermood</span>',
              '<span>Post: x.com/user/status/123 (link only)</span>',
              '<span class="quote">&gt;source: en.wikipedia.org/wiki/Clover_(disambigu<wbr>ation).</span>',
              '<span>Spoiler: <s>www.example.org/secret</s></span>',
              '<span>Stays text: javascript:alert(1) data:text/html,x me@example.org/x file.txt</span>',
            ].join('<br>'),
          }]
        : [];
      return { freshness: 'new', data: { posts: [first, ...replies, ...grown, ...cross, ...links] } };
    },
    // The mock never opens the site: it only records what would open.
    posts: [],
    async openPost(board, thread = null, quote = null) {
      this.posts.push({ board, thread, quote });
      return { mock: true };
    },
    // A pretend captcha (local pictures) and a pretend post endpoint: the
    // answer "21" passes, anything else gets the site's mistyped error.
    async captcha() {
      siteRequests += 1;
      await sleep(Math.min(delay, 200));
      if (mock.captcha === 'wait') return { error: 'You have to wait a while before doing this again.', cd: 30 };
      if (mock.captcha === 'none') return { challenge: 'noop' };
      if (mock.captcha === 'spur') return { error: 'Please unblock spur.us and mcl.io to proceed.' };
      // Inline pictures, as the site sends (it sends base64 PNGs).
      const svg = (w, body) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="80">${body}</svg>`)}`;
      // The site's shape: tasks, each a prompt and choices; the answer is the
      // picked positions joined. Here: "Pick the 3" (3rd choice) and "Pick
      // the 7" (2nd), so the right answer is "21".
      const num = (n) => svg(300, `<rect width="300" height="80" fill="#e8e4da"/><text x="130" y="56" font-size="44" font-family="monospace" fill="#222">${n}</text>`);
      return {
        challenge: 'mock-challenge',
        ttl: 120,
        tasks: [
          // like the site: the object to find is a picture inside the question
          // (a drawn "3", made up for the preview)
          { str: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAIAAAC1nk4lAAADVklEQVR42mN88eQWw1ADTAxDEIw6etTRo44edfSoo0cdPepoBgYGBhbKjfj46dP585cuX7n+4OGjJ0+effr0+eu3b4yMjJycHJwcHGJionJyMirKipbmpnJyMlRxNCPZDaYPHz7u2Xdw5+59167d/P//PzFaFBXlE2IjnZ3smZgYB8bR5VWNh48cJ0OjsZFBW3MNLy/PUErTZ89dyC0o//37zxDLiLdu3124ePnQKz02bt7+79//gSk9GBkZNTXULC1M1dVUlBTl+fj5uDg5v3//8fzFy/PnL61dv+nR46dYNb59++7evfsqKkp0dbSoiHBKUqy/r6ewsBCaFDc3l4qyooqyYoC/V21D+6HDx7Ca8Or1G3o7uqQoh6AaVlbW0uLcw0eOYy0Tf/78OUjTtLCQIDc3N3YpjCgaLI5++/bd169fMcXZ2dnU1VQHo6N///7T2z8Va9rwdHdhZ2cbsLYHGvjz58/Xb9+eP3tx/uKVjZu2Yi09JCTEMtISB7LBxMDAMGHSjFVrNhCpWFVVuaO1jo+Pd4AdTSRQUVEKDvDx9nJjYWEZGu1pAX4+U2NDAwNdCl1MV0d/+Php+cq10XFp7Z393759H0o9l3///m/eujM9q/Djp09DrMF0996Duob2AegE4AK/fv36+vXb8xcvr1y9vmfvwStXr+NS2dlWb2tjOSgcjQZ27dnf3Nrz9+9fTClrK/PujsbBmDzcXByjIkKwSl28dHXwpmk7HGngy5cv5BUjdMmIuLvev37/HqSOPnL0BPbamIWFn6zKnBxHf/n6NTktb936LcSUtXv2HVy6fA1WKUkJcUZGRnq1Pf7/v37j1vUbt/omTtVQVzM1MVRWVlRUkBcSFODh4WZiYvr+/fvz5y+vXLuxe8+BCxcv4zLG3s5qABpM//79v3b95rXrN8nQy8zM7OXpOsSGEBLjoxTk5YaSo709XeNjI4ZGe5qBgYGTkzM5MRpXdUPbavzGjVs7du3bd+DwmzdvidQiIiLs6uwQExUqKCgwYEO9EPDg4aNz5y/dun338eMnz56//Pr12/fv35mYmLg4OTm5OISFhBTkZRUU5A30dbQ01ckr4AagwcQwOn0x6uhRR486etTRo44edfSoo0cdPepoogAArds9e7W1jWEAAAAASUVORK5CYII=" style="float:right;margin:10px 0 0 10px">Pick the 3', items: [num(1), num(2), num(3), num(4)] },
          { str: 'Pick the 7', items: [num(5), num(7), num(9)] },
        ],
      };
    },
    async submitPost(board, fields, file = null) {
      siteRequests += 1;
      await sleep(Math.min(delay, 200));
      this.lastPost = { board, fields, file: file ? { name: file.name, type: file.type, size: file.b64.length } : null };
      if (fields['t-challenge'] !== 'noop' && fields['t-response'] !== '21') {
        return { status: 200, text: '<span id="errmsg" style="color:red;">Error: You seem to have mistyped the CAPTCHA.</span>' };
      }
      mockPostNo += 1;
      const thread = fields.resto ? Number(fields.resto) : 0;
      return { status: 200, text: `<html><!-- thread:${thread},no:${mockPostNo} --></html>` };
    },
    async openWindow(panes) {
      globalThis.open?.(`${location.pathname}${location.search}#panes=${panes}`, '_blank', 'noopener');
      return 'mock-window';
    },
    async showSiteWindow() {
      return null; // no helper window in the browser preview
    },
    async saveMedia(url, name) {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      return `Downloads/${name}`;
    },
    // Saved threads: kept in this browser's storage (no files are written;
    // a file "saved" is only remembered), so the Saved list and the saved
    // pane can be tried. ?mock-save=fail makes every full file fail.
    async offlineList() {
      return [...mockSaved().values()].map((e) => ({
        board: e.board,
        no: e.no,
        title: e.title,
        folder: `${MOCK_SAVED_DIR}/${e.board}-${e.no}`,
        savedAt: e.savedAt,
        posts: e.thread.posts.length,
        files: e.files.length,
        bytes: JSON.stringify(e.thread).length + e.files.length * 48000 + e.thumbs.length * 4000,
      }));
    },
    async offlineRead(_dir, board, no) {
      await sleep(Math.min(delay, 120));
      const e = mockSaved().get(`${board}/${no}`);
      if (!e) throw new Error('not-saved');
      return { thread: structuredClone(e.thread), folder: `${MOCK_SAVED_DIR}/${board}-${no}`, title: e.title, savedAt: e.savedAt, files: [...e.files], thumbs: [...e.thumbs] };
    },
    async offlineWriteThread(_dir, board, no, title, thread) {
      const store = mockSaved();
      const prev = store.get(`${board}/${no}`);
      store.set(`${board}/${no}`, { board, no, title, savedAt: Date.now(), thread: structuredClone(thread), files: prev?.files || [], thumbs: prev?.thumbs || [] });
      keepSaved(store);
      return `${MOCK_SAVED_DIR}/${board}-${no}`;
    },
    async offlineFetchFile(_dir, board, no, job) {
      const store = mockSaved();
      const e = store.get(`${board}/${no}`);
      if (!e) throw new Error('Save the thread first.');
      const list = job.kind === 'thumb' ? e.thumbs : e.files;
      const name = job.kind === 'thumb' ? `${job.tim}s.jpg` : `${job.tim}${job.ext}`;
      if (list.includes(name)) return { status: 'skipped' };
      siteRequests += 1;
      await sleep(Math.min(delay, 150));
      if (mock.save === 'fail' && job.kind === 'full') throw new Error('Could not reach the image host (mock failure).');
      list.push(name);
      keepSaved(store);
      return { status: 'saved', bytes: 1 };
    },
    async offlineDelete(_dir, board, no) {
      const store = mockSaved();
      store.delete(`${board}/${no}`);
      keepSaved(store);
    },
    savedFileUrl: (path) => {
      const tim = Number(/\/(\d+)s?\.\w+$/.exec(String(path))?.[1] || 0);
      return MOCK_THUMBS[tim % MOCK_THUMBS.length];
    },
    downloads: [],
    async downloadFile(url, name, _dir = '', size = 0) {
      if (this.downloads.some((d) => d.name === name && d.size === size)) return { status: 'skipped', path: `Downloads/${name}` };
      siteRequests += 1;
      await sleep(Math.min(delay, 150));
      this.downloads.push({ url, name, size });
      return { status: 'saved', path: `Downloads/${name}` };
    },
    // Stats in this browser's storage, with the app's revision check.
    // ?mock-stats seeds a day of board samples and a month of your own
    // counts the first time each is read (when there is little there).
    async statsRead(kind) {
      if (!STATS_KINDS.includes(kind)) throw new Error('unknown stats file');
      let data = readStats(kind);
      if (mock.stats && !seeded.has(kind)) {
        seeded.add(kind);
        const now = Date.now();
        const few = kind === 'boards' ? Object.values(data?.boards || {}).reduce((n, e) => n + (e.samples?.length || 0), 0) < 50 : !Object.keys(data?.days || {}).length;
        if (few) {
          const seed = kind === 'boards' ? seedBoardStats(await mockCatalog(), now) : seedMine(now);
          data = { ...seed, rev: (data?.rev || 0) + 1 };
          keepStats(kind, data);
        }
      }
      return data;
    },
    async statsWrite(kind, data, rev) {
      if (!STATS_KINDS.includes(kind)) throw new Error('unknown stats file');
      const cur = readStats(kind);
      if ((cur?.rev || 0) !== rev) throw new Error('stats-conflict');
      keepStats(kind, { ...data, rev: rev + 1 });
      return rev + 1;
    },
    async fetchBusy() {
      return inflight;
    },
    onSettingsChanged(cb) {
      globalThis.addEventListener?.('storage', (e) => {
        if (e.key !== STORAGE_KEY || !e.newValue) return;
        try {
          cb(JSON.parse(e.newValue));
        } catch {
          /* not ours */
        }
      });
    },
    // No outside requests from the mock: every file shows a local picture.
    thumbUrl: (_board, post) => (post.tim ? MOCK_THUMBS[Number(post.tim) % MOCK_THUMBS.length] : null),
    // no outside requests in the preview: the flag shows as its code
    flag: (board, post) => postFlag(board, post, false),
    mediaUrl: (_board, post) => (post.tim ? MOCK_THUMBS[Number(post.tim) % MOCK_THUMBS.length] : null),
    async requestNotificationPermission() {
      if (mock.notify) return mock.notify;
      const N = globalThis.Notification;
      if (!N || typeof N.requestPermission !== 'function') return 'unsupported';
      try {
        return await N.requestPermission();
      } catch {
        return 'denied';
      }
    },
    async openExternal(url) {
      globalThis.open?.(url, '_blank', 'noopener,noreferrer');
    },
    async openLink(url) {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('Only http and https links open from posts.');
      globalThis.open?.(url, '_blank', 'noopener,noreferrer');
    },
    window: { available: false, minimize() {}, toggleMaximize() {}, close() {}, setTitle() {} },
  };
}

/** Reads ?mock-boards=fail|fail-once and ?mock-ffmpeg=missing|partial|no-vp9
 *  from the page URL, for checking every wizard state in a browser. */
export function mockOptionsFromSearch(search) {
  const p = new URLSearchParams(search || '');
  const o = {};
  if (p.get('mock-boards')) o.boards = p.get('mock-boards');
  if (p.get('mock-ffmpeg')) o.ffmpeg = p.get('mock-ffmpeg');
  if (p.get('mock-notify')) o.notify = p.get('mock-notify');
  if (p.get('mock-catalog')) o.catalog = p.get('mock-catalog');
  if (p.has('mock-grow')) o.grow = true;
  if (p.has('mock-cross')) o.cross = true;
  if (p.has('mock-links')) o.links = true;
  if (p.has('mock-stats')) o.stats = true;
  if (p.get('mock-captcha')) o.captcha = p.get('mock-captcha');
  if (p.get('mock-save')) o.save = p.get('mock-save');
  if (p.has('mock-delay')) {
    const n = Number(p.get('mock-delay'));
    if (Number.isFinite(n) && n >= 0) o.delayMs = n;
  }
  return o;
}
