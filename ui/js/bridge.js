// The UI's only door to the outside. Inside the desktop app it calls the
// Rust core through Tauri's `invoke`; in a plain browser it is a mock so the
// UI can be built and checked without the app (settings in localStorage,
// boards from the recorded fixture, a synthetic catalog, a canned ffmpeg
// check, local pictures instead of the image host).

const STORAGE_KEY = 'clovereye.settings';
const MEDIA_BASE = 'https://i.4cdn.org';
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
      /** Another window saved new settings. */
      onSettingsChanged(cb) {
        tauri.event?.listen?.('settings-changed', (e) => cb(e.payload));
      },
      // Media loads in the webview straight from the image host (SCOPE §4.1).
      thumbUrl: (board, post) => (post.tim ? `${MEDIA_BASE}/${board}/${post.tim}s.jpg` : null),
      mediaUrl: (board, post) => (post.tim && post.ext ? `${MEDIA_BASE}/${board}/${post.tim}${post.ext}` : null),
      // Native notifications arrive with the tray in C2; until then the
      // switch is stored and the OS is asked when the feature lands.
      async requestNotificationPermission() {
        return 'later';
      },
      async openExternal(url) {
        await invoke('plugin:opener|open_url', { url });
      },
      window: {
        available: Boolean(tauri.window?.getCurrentWindow),
        minimize: () => win()?.minimize(),
        toggleMaximize: () => win()?.toggleMaximize(),
        close: () => win()?.close(),
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
      await sleep(delay);
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
    // for every board, and builds threads from its OPs and last replies.
    async fetchCatalog() {
      siteRequests += 1;
      await sleep(delay);
      if (mock.catalog === 'fail') throw new Error('Could not reach the catalog (mock failure).');
      return { freshness: 'new', data: await mockCatalog() };
    },
    async fetchThread(board, no) {
      siteRequests += 1;
      await sleep(delay);
      const cat = await mockCatalog();
      const op = cat.flatMap((p) => p.threads).find((t) => t.no === Number(no));
      if (!op) throw new Error('not-found');
      const { last_replies: replies = [], omitted_posts: _a, omitted_images: _b, last_modified: _c, ...first } = op;
      // ?mock-grow: every later fetch of the same thread brings one new reply.
      const n = (threadFetches.get(op.no) || 0) + 1;
      threadFetches.set(op.no, n);
      const grown = mock.grow
        ? Array.from({ length: n - 1 }, (_, i) => ({ no: op.no + 900000 + i, resto: op.no, now: '', time: op.time + i + 1, name: 'Anonymous', com: `New reply ${i + 1}` }))
        : [];
      return { freshness: 'new', data: { posts: [first, ...replies, ...grown] } };
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
          { str: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" style="float:right;margin:10px 0 0 10px">Pick the 3', items: [num(1), num(2), num(3), num(4)] },
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
    window: { available: false, minimize() {}, toggleMaximize() {}, close() {} },
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
  if (p.get('mock-captcha')) o.captcha = p.get('mock-captcha');
  if (p.has('mock-delay')) {
    const n = Number(p.get('mock-delay'));
    if (Number.isFinite(n) && n >= 0) o.delayMs = n;
  }
  return o;
}
