// Third-party archives: where a thread or post the site no longer has can
// still be read. DOM-free (tested with node --test). Links open in the
// system browser (bridge.openExternal); nothing is fetched from an archive.
//
// The list is kept by hand, after 4chan X's archive list: which archive
// keeps which board changes now and then, so check it at each release.
// Order matters: "Automatic" picks the first archive that keeps a board,
// so the archives that keep few boards come before the catch-all ones.
// Each host must also be in src-tauri/capabilities/default.json (opener),
// which tests/archive-model.test.mjs checks.

/** software: 'foolfuuka' (/g/thread/1/#2, /g/post/2/) or 'fuuka' (/g/thread/1#p2, /g/post/2). */
export const ARCHIVES = Object.freeze(
  [
    {
      id: 'desuarchive',
      host: 'desuarchive.org',
      software: 'foolfuuka',
      boards: ['a', 'aco', 'an', 'c', 'cgl', 'co', 'd', 'fit', 'g', 'his', 'int', 'k', 'm', 'mlp', 'mu', 'q', 'qa', 'r9k', 'tg', 'trash', 'vr', 'wsg'],
    },
    {
      id: '4plebs',
      host: 'archive.4plebs.org',
      software: 'foolfuuka',
      boards: ['adv', 'f', 'hr', 'mlpol', 'mo', 'o', 'pol', 's4s', 'sp', 'tg', 'trv', 'tv', 'x'],
    },
    {
      id: 'warosu',
      host: 'warosu.org',
      software: 'fuuka',
      boards: ['3', 'biz', 'cgl', 'ck', 'diy', 'fa', 'ic', 'jp', 'lit', 'sci', 'vr', 'vt'],
    },
    {
      id: 'b4k',
      host: 'arch.b4k.dev',
      software: 'foolfuuka',
      boards: ['g', 'mlp', 'qb', 'v', 'vg', 'vm', 'vmg', 'vp', 'vrpg', 'vst'],
    },
    {
      id: 'thebarchive',
      host: 'thebarchive.com',
      software: 'foolfuuka',
      boards: ['b', 'bant'],
    },
    {
      id: 'archiveofsins',
      host: 'archiveofsins.com',
      software: 'foolfuuka',
      boards: ['h', 'hc', 'hm', 'i', 'lgbt', 'r', 's', 'soc', 't', 'u'],
    },
    {
      id: 'palanq',
      host: 'archive.palanq.win',
      software: 'foolfuuka',
      boards: ['bant', 'c', 'con', 'e', 'i', 'n', 'news', 'out', 'p', 'pw', 'qst', 'toy', 'vip', 'vp', 'vt', 'w', 'wg', 'wsr'],
    },
    {
      id: 'archivedmoe',
      host: 'archived.moe',
      software: 'foolfuuka',
      boards: [
        '3', 'a', 'aco', 'adv', 'an', 'asp', 'b', 'bant', 'biz', 'c', 'cgl', 'ck', 'cm', 'co', 'd', 'diy', 'e', 'f', 'fa', 'fit',
        'g', 'gd', 'gif', 'h', 'hc', 'his', 'hm', 'hr', 'i', 'ic', 'int', 'jp', 'k', 'lgbt', 'lit', 'm', 'mlp', 'mlpol', 'mo', 'mu',
        'n', 'news', 'o', 'out', 'p', 'po', 'pol', 'pw', 'q', 'qa', 'qb', 'qst', 'r', 'r9k', 's', 's4s', 'sci', 'soc', 'sp', 't',
        'tg', 'toy', 'trash', 'trv', 'tv', 'u', 'v', 'vg', 'vint', 'vip', 'vm', 'vmg', 'vp', 'vr', 'vrpg', 'vst', 'vt', 'w', 'wg',
        'wsg', 'wsr', 'x', 'xs', 'y',
      ],
    },
  ].map((a) => Object.freeze({ ...a, boards: Object.freeze([...a.boards]) })),
);

export const ARCHIVE_IDS = Object.freeze(ARCHIVES.map((a) => a.id));
/** A board's choice that means no archive links for it. */
export const ARCHIVE_OFF = 'off';
/** At most this many per-board choices are kept in settings. */
export const MAX_ARCHIVE_CHOICES = 300;

const isBoard = (b) => typeof b === 'string' && /^[a-z0-9]{1,10}$/.test(b);
const isNo = (n) => Number.isSafeInteger(n) && n > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The archives that keep a board, in the list's order. */
export function archivesFor(board) {
  return isBoard(board) ? ARCHIVES.filter((a) => a.boards.includes(board)) : [];
}

/** Every board some archive keeps, sorted. */
export function archivedBoards() {
  return [...new Set(ARCHIVES.flatMap((a) => a.boards))].sort();
}

/** Settings → Archives: { enabled, boards: { board → archive id | 'off' } }.
 *  A board without a choice gets the first archive that keeps it. */
export const DEFAULT_ARCHIVE_PREFS = Object.freeze({ enabled: true, boards: Object.freeze({}) });

/** Stored choices → valid ones: known boards, archives that keep them, or 'off'. */
export function normalizeArchivePrefs(raw) {
  const out = { enabled: true, boards: {} };
  if (!isObj(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (isObj(raw.boards)) {
    let n = 0;
    for (const [board, id] of Object.entries(raw.boards)) {
      if (n >= MAX_ARCHIVE_CHOICES) break;
      if (!isBoard(board)) continue;
      if (id !== ARCHIVE_OFF && !archivesFor(board).some((a) => a.id === id)) continue;
      out.boards[board] = id;
      n++;
    }
  }
  return out;
}

/** The archive used for a board, or null (none keeps it, or it is off). */
export function pickArchive(board, prefs = DEFAULT_ARCHIVE_PREFS) {
  if (prefs && prefs.enabled === false) return null;
  const list = archivesFor(board);
  const choice = prefs?.boards?.[board];
  if (choice === ARCHIVE_OFF) return null;
  return list.find((a) => a.id === choice) || list[0] || null;
}

/**
 * The address of a thread or post on an archive. `thread` alone: the thread;
 * `thread` and `post`: the post in it; `post` alone: the archive finds the
 * thread. null when the parts are not a board code and post numbers.
 */
export function archiveUrl(archive, { board, thread = 0, post = 0 } = {}) {
  if (!archive || !isBoard(board)) return null;
  const t = isNo(thread) ? thread : 0;
  const p = isNo(post) ? post : 0;
  if (!t && !p) return null;
  const ff = archive.software === 'foolfuuka';
  let url = `https://${archive.host}/${board}/${t ? `thread/${t}` : `post/${p}`}${ff ? '/' : ''}`;
  if (t && p && p !== t) url += ff ? `#${p}` : `#p${p}`;
  return url;
}

/** { id, host, url } for a thread or post on the board's chosen archive, or null. */
export function archiveLink(prefs, ref) {
  const a = pickArchive(ref?.board, prefs);
  const url = a && archiveUrl(a, ref);
  return url ? { id: a.id, host: a.host, url } : null;
}

/**
 * What a dead quote link (a "deadlink": a post the site no longer has)
 * points at, from its text: ">>123" (this board) or ">>>/g/123". The thread
 * is not known, so the archive is asked for the post. null for anything else.
 */
export function deadlinkRef(text, board) {
  const s = String(text ?? '').trim();
  let m = /^>>(\d{1,16})$/.exec(s);
  if (m && isBoard(board)) {
    const post = Number(m[1]);
    return isNo(post) ? { board, post } : null;
  }
  m = /^>>>\/([a-z0-9]{1,10})\/(\d{1,16})$/.exec(s);
  if (m) {
    const post = Number(m[2]);
    return isNo(post) ? { board: m[1], post } : null;
  }
  return null;
}
