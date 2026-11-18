// The Library view (meme gallery): everything kept in the library folder,
// to search, tag, sort into collections, weed out look-alikes and bring
// more in. Keeps its own DOM and state (the shell's redraws move the node,
// they do not rebuild it), so a search being typed is never wiped.

import * as L from './library-model.js';
import { aiReady } from './ai-model.js';
import { h, icon, clear, toast } from './dom.js';
import { confirmDialog } from './offline.js';
import { formatBytes } from './render.js';
import { log } from './log.js';
import { errorKind } from './log-model.js';

const PAGE = 240;

/**
 * @param {object} o
 * @param {ReturnType<import('./library.js').createLibrary>} o.library
 * @param {object} o.bridge
 * @param {() => object} o.getSettings
 * @param {(next: object) => void} o.saveSettings
 * @param {(p: {board: string, thread: number, no: number}) => void} o.onOpenPost
 * @param {() => Map} o.knownFiles   files seen in threads (library-model knownFiles)
 * @param {string} o.keyPrefix
 */
export function createLibraryView(o) {
  const { library: lib, keyPrefix: k = '' } = o;
  const f = { q: '', kind: 'all', board: '', collection: '', tag: '', source: '', sort: 'added' };
  let selected = '';
  let shown = PAGE;
  let mode = 'all'; // or 'lookalikes'
  let busy = ''; // what is running: an import, AI tagging
  let visionModels = null; // null: not asked yet
  let picking = false; // Select pressed: a press picks a file
  const picked = new Set(); // ids picked
  const node = h('div', { class: 'browse library', 'data-key': `${k}library` });
  // Tiles kept across draws (by id, for the grid and the look-alikes), so a
  // press or a letter typed does not load every picture and video again.
  const tiles = { grid: new Map(), look: new Map() };
  const used = { grid: new Set(), look: new Set() };
  let preview = null; // { id, url, el }: the detail's picture or video
  let lookCache = { v: -1, items: null, groups: [] };

  const ai = () => {
    const a = o.getSettings().ai || {};
    return { ...a, ready: aiReady(a) && Boolean(a.vision) };
  };

  function draw() {
    const active = document.activeElement;
    const focusKey = node.contains(active) ? active?.dataset?.key : null;
    const caret = focusKey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const scroller = node.querySelector('.library__grid-wrap');
    const scroll = scroller ? scroller.scrollTop : 0;
    used.grid.clear();
    used.look.clear();
    clear(node).append(...content().filter(Boolean));
    for (const kind of ['grid', 'look']) for (const id of tiles[kind].keys()) if (!used[kind].has(id)) tiles[kind].delete(id);
    const wrap = node.querySelector('.library__grid-wrap');
    if (wrap) wrap.scrollTop = scroll;
    if (focusKey) {
      const el = node.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      el?.focus({ preventScroll: true });
      if (el && caret && typeof el.setSelectionRange === 'function') el.setSelectionRange(caret[0], caret[1]);
    }
  }

  function content() {
    // Settings → Files names another library folder: read that one
    if (lib.stale?.()) lib.load();
    const st = lib.state();
    if (!lib.available()) return [h('p', { class: 'state-line', text: 'The library needs the desktop app.' })];
    if (st.status === 'idle' || st.status === 'loading') return [h('p', { class: 'state-line', role: 'status', text: 'Opening the library…' })];
    if (st.status === 'error') {
      return [
        h('p', { class: 'state-line', role: 'alert', text: `Couldn’t open the library: ${st.error}` }),
        h('button', { type: 'button', class: 'btn', 'data-key': `${k}library-retry`, onclick: () => lib.load(true), text: 'Try again' }),
      ];
    }
    const all = lib.items();
    for (const id of [...picked]) if (!lib.find(id)) picked.delete(id);
    return [bar(all), tagRow(all), statusLine(all), picking ? pickBar(all) : null, mode === 'lookalikes' ? lookalikes(all) : main(all)];
  }

  // ------------------------------------------------------------- the bar

  function select(key, label, value, options, onPick) {
    return h(
      'select',
      { class: 'input library__select', 'aria-label': label, 'data-key': `${k}${key}`, onchange: (e) => onPick(e.target.value) },
      options.map(([v, text]) => h('option', { value: v, selected: v === value, text })),
    );
  }

  function bar(all) {
    const set = (field) => (v) => {
      f[field] = v;
      shown = PAGE;
      draw();
    };
    const picker = (folder) =>
      h(
        'label',
        { class: `btn${busy ? ' btn--disabled' : ''}`, title: folder ? 'Bring in every picture and video of a folder' : 'Bring in pictures and videos from your computer' },
        icon(folder ? 'folder' : 'upload'),
        folder ? 'Import folder' : 'Import files',
        h('input', {
          type: 'file',
          class: 'visually-hidden',
          multiple: true,
          disabled: Boolean(busy),
          accept: 'image/jpeg,image/png,image/gif,image/webp,video/webm,video/mp4,.jpg,.jpeg,.png,.gif,.webp,.webm,.mp4',
          'data-key': `${k}library-import${folder ? '-folder' : ''}`,
          ...(folder ? { webkitdirectory: '' } : {}),
          onchange: (e) => runImport([...(e.target.files || [])]),
        }),
      );
    const boards = L.boardsOf(all);
    return h(
      'div',
      { class: 'browse__tools browse__tools--sticky library__bar' },
      h('input', {
        type: 'search',
        class: 'input library__search',
        placeholder: 'Search names, tags, threads',
        'aria-label': 'Search the library',
        value: f.q,
        'data-key': `${k}library-search`,
        oninput: (e) => {
          f.q = e.target.value;
          shown = PAGE;
          draw();
        },
      }),
      select('library-kind', 'Kind of file', f.kind, [['all', 'All files'], ['image', 'Pictures'], ['gif', 'GIFs'], ['video', 'Videos']], set('kind')),
      boards.length ? select('library-board', 'Board', f.board, [['', 'All boards'], ...boards.map((b) => [b, `/${b}/`])], set('board')) : null,
      select('library-collection', 'Collection', f.collection, [['', 'All collections'], ...lib.collections().map((c) => [c, c])], set('collection')),
      sourceSelect(all, set('source')),
      select('library-sort', 'Sort', f.sort, [['added', 'Newest kept'], ['posted', 'Newest posted'], ['size', 'Largest'], ['name', 'Name']], set('sort')),
      h(
        'span',
        { class: 'library__actions' },
        h(
          'button',
          {
            type: 'button',
            class: `btn${mode === 'lookalikes' ? ' btn--on' : ''}`,
            'aria-pressed': String(mode === 'lookalikes'),
            title: 'Pictures that look the same, even resized or saved again',
            'data-key': `${k}library-lookalikes`,
            onclick: () => {
              mode = mode === 'lookalikes' ? 'all' : 'lookalikes';
              draw();
            },
          },
          icon('layers'),
          'Look-alikes',
        ),
        all.length
          ? h(
              'button',
              {
                type: 'button',
                class: `btn${picking ? ' btn--on' : ''}`,
                'aria-pressed': String(picking),
                title: 'Pick several files to tag, collect or remove at once (or Shift/Cmd-click any file)',
                'data-key': `${k}library-select`,
                onclick: () => {
                  picking = !picking;
                  if (!picking) picked.clear();
                  draw();
                },
              },
              icon('check'),
              'Select',
            )
          : null,
        aiButton(all),
        picker(false),
        lib.canBrowse()
          ? h(
              'button',
              { type: 'button', class: 'btn', disabled: Boolean(busy), title: 'Bring in every picture and video of a folder', 'data-key': `${k}library-import-folder`, onclick: (e) => browseFolders(e.currentTarget) },
              icon('folder'),
              'Import folder',
            )
          : picker(true),
      ),
    );
  }

  /** Where files came from: threads, files imported one by one, or each
   *  folder imported. */
  function sourceSelect(all, onPick) {
    const folders = L.foldersOf(all, lib.folders());
    if (!folders.length) return null;
    if (f.source.startsWith('dir:') && !folders.some(([d]) => `dir:${d}` === f.source)) f.source = '';
    return select('library-source', 'Where files came from', f.source, [
      ['', 'From anywhere'],
      ['threads', 'Saved from threads'],
      ['files', 'Imported files'],
      ...folders.map(([d, n]) => [`dir:${d}`, `${L.folderName(d)} (${n})`]),
    ], onPick);
  }

  function aiButton(all) {
    const a = ai();
    if (!a.enabled) return null;
    const untagged = all.filter((e) => !e.tags.length && (e.kind === 'image' || e.kind === 'gif'));
    if (!a.ready) {
      return h(
        'span',
        { class: 'library__vision' },
        visionPicker(),
      );
    }
    return h(
      'button',
      {
        type: 'button',
        class: 'btn',
        disabled: Boolean(busy) || !untagged.length,
        title: `Let ${a.vision} look at the pictures without tags and tag them (on this computer)`,
        'data-key': `${k}library-ai-all`,
        onclick: () => tagAll(untagged),
      },
      icon('sparkle'),
      untagged.length ? `Tag ${untagged.length} with AI` : 'All tagged',
    );
  }

  /** The assistant's picture model: chosen here, once. */
  function visionPicker() {
    const a = ai();
    if (visionModels === null) {
      visionModels = [];
      Promise.resolve(o.bridge.aiDetect?.(a.port))
        .then((r) => {
          const server = r?.servers?.find((s) => s.kind === a.kind && s.port === a.port) || r?.servers?.[0];
          visionModels = L.visionModels(server?.models || []);
          draw();
        })
        .catch(() => {});
    }
    if (!visionModels.length) {
      return h('span', { class: 'field__hint', title: 'For example: ollama pull llava', text: 'AI tags need a model that sees pictures (llava, gemma3, qwen2.5vl…).' });
    }
    return select('library-vision', 'Picture model for AI tags', '', [['', 'AI tags: choose a model…'], ...visionModels.map((m) => [m, m])], (m) => {
      const s = o.getSettings();
      o.saveSettings({ ...s, ai: { ...(s.ai || {}), vision: m } });
      draw();
    });
  }

  function tagRow(all) {
    const counts = L.tagCounts(all);
    const untagged = all.filter((e) => !e.tags.length).length;
    const chip = (value, text, n) =>
      h(
        'button',
        {
          type: 'button',
          class: `library__tag${f.tag === value ? ' library__tag--on' : ''}`,
          'aria-pressed': String(f.tag === value),
          'data-key': `${k}library-tag-${value || 'all'}`,
          onclick: () => {
            f.tag = f.tag === value ? '' : value;
            shown = PAGE;
            draw();
          },
        },
        h('span', { translate: value && value !== 'untagged' ? 'no' : null, text }),
        n != null ? h('span', { class: 'library__tag-n', text: String(n) }) : null,
      );
    if (!all.length) return null;
    return h(
      'div',
      { class: 'library__tags', role: 'group', 'aria-label': 'Tags' },
      chip('', 'All', all.length),
      untagged ? chip('untagged', 'No tags', untagged) : null,
      counts.slice(0, 30).map(([t, n]) => chip(t, t, n)),
    );
  }

  function statusLine(all) {
    const st = lib.state();
    const size = all.reduce((a, e) => a + e.size, 0);
    return h(
      'p',
      { class: 'library__status', role: 'status' },
      busy ? h('span', { class: 'library__busy', text: busy }) : null,
      h('span', { text: all.length === 1 ? `1 file · ${formatBytes(size)}` : `${all.length} files · ${formatBytes(size)}` }),
      h('span', { class: 'library__root', translate: 'no', title: 'The library folder (Settings → Files)', text: st.root }),
      st.error ? h('span', { class: 'field__error', text: st.error }) : null,
      folderLine(all),
    );
  }

  /** With an imported folder chosen: where it is, and taking it out. */
  function folderLine(all) {
    if (!f.source.startsWith('dir:')) return null;
    const folder = f.source.slice(4);
    const n = all.filter((e) => e.folder === folder).length;
    const info = lib.folderInfo(folder);
    return h(
      'span',
      { class: 'library__folder' },
      h('span', { class: 'library__root', translate: 'no', title: folder, text: folder }),
      info?.at ? h('span', { text: `Scanned ${new Date(info.at).toLocaleString()}` }) : null,
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--sm',
          disabled: Boolean(busy),
          title: 'Looks in the folder again and brings in what was added since',
          'data-key': `${k}library-rescan`,
          onclick: () => runFolderImport(folder, null),
        },
        icon('refresh'),
        'Rescan',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--sm btn--danger',
          disabled: Boolean(busy),
          title: 'Takes this folder’s files out of the library; the folder on your computer stays as it is',
          'data-key': `${k}library-remove-folder`,
          onclick: async (ev) => {
            const ok = await confirmDialog({
              title: 'Remove this imported folder?',
              text: n === 1 ? `1 file imported from “${L.folderName(folder)}” is deleted from the library, with its tags. The folder on your computer stays as it is.` : `${n} files imported from “${L.folderName(folder)}” are deleted from the library, with their tags. The folder on your computer stays as it is.`,
              confirm: 'Remove',
              opener: ev.currentTarget,
            });
            if (!ok) return;
            busy = 'Removing…';
            draw();
            const done = await lib.removeFolder(folder);
            busy = '';
            f.source = '';
            selected = '';
            draw();
            toast(done === 1 ? 'Removed 1 file.' : `Removed ${done} files.`);
          },
        },
        icon('trash'),
        'Remove folder',
      ),
    );
  }

  // ------------------------------------------------------------ the grid

  /** A file's tile. Kept from the last draw when nothing on it changed;
   *  its picture or video is kept whenever the file is the same. `look`: a
   *  look-alike's tile (a press shows it in the library). */
  function tile(e, look = false) {
    const kind = look ? 'look' : 'grid';
    const id = e.id;
    const url = lib.fileUrl(e);
    const isPicked = picked.has(id);
    const key = [url, e.name, e.tags.join(','), e.kind, e.ext, id === selected, isPicked, picking].join('\n');
    used[kind].add(id);
    const had = tiles[kind].get(id);
    if (had?.key === key) return had.node;
    const media =
      had?.url === url
        ? had.media
        : e.kind === 'video'
          ? h('video', { src: url, muted: true, preload: 'metadata', 'aria-hidden': 'true' })
          : h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' });
    const onclick = look
      ? () => {
          selected = id;
          mode = 'all';
          draw();
        }
      : (ev) => {
          if (picking || ev.shiftKey || ev.metaKey || ev.ctrlKey) {
            picking = true;
            if (picked.has(id)) picked.delete(id);
            else picked.add(id);
          } else selected = selected === id ? '' : id;
          draw();
        };
    const li = h(
      'li',
      { class: `library__tile${id === selected ? ' library__tile--on' : ''}${isPicked ? ' library__tile--picked' : ''}` },
      h(
        'button',
        {
          type: 'button',
          class: 'library__thumb',
          'aria-label': `${e.name}${e.tags.length ? ` · ${e.tags.join(', ')}` : ''}`,
          'aria-pressed': String(picking ? isPicked : id === selected),
          title: e.name,
          'data-key': `${k}library-item-${id}`,
          onclick,
        },
        picking ? h('span', { class: `library__pick${isPicked ? ' library__pick--on' : ''}`, 'aria-hidden': 'true' }, isPicked ? icon('check') : null) : null,
        media,
        e.kind !== 'image' ? h('span', { class: 'library__badge', text: e.kind === 'gif' ? 'GIF' : e.ext.toUpperCase() }) : null,
        !e.tags.length ? h('span', { class: 'library__badge library__badge--untagged', title: 'No tags yet' }, icon('tag')) : null,
      ),
    );
    tiles[kind].set(id, { key, url, media, node: li });
    return li;
  }

  function main(all) {
    const list = L.filterItems(all, f);
    if (selected && !all.some((e) => e.id === selected)) selected = '';
    const sel = selected ? lib.find(selected) : null;
    return h(
      'div',
      { class: `library__main${sel ? ' library__main--detail' : ''}` },
      h(
        'div',
        { class: 'library__grid-wrap' },
        !all.length
          ? empty()
          : !list.length
            ? h('p', { class: 'state-line', text: 'Nothing matches.' })
            : h('ul', { class: 'library__grid', 'aria-label': 'Library files' }, list.slice(0, shown).map((e) => tile(e))),
        list.length > shown
          ? h('button', { type: 'button', class: 'btn library__more', 'data-key': `${k}library-more`, onclick: () => ((shown += PAGE), draw()), text: `Show more (${list.length - shown} left)` })
          : null,
      ),
      sel ? detail(sel) : null,
    );
  }

  function empty() {
    return h(
      'div',
      { class: 'library__empty' },
      icon('images'),
      h('p', { text: 'The library is empty.' }),
      h('p', { class: 'field__hint', text: 'Save a file from a thread (the gallery’s Save, the file’s menu, or Download all) and it lands here with its thread, post and date. Or import the memes you already have.' }),
    );
  }

  // ---------------------------------------------------------- the detail

  /** The selected file, big: the same element while it stays selected, so a
   *  tag added does not load it again (or stop a video playing). */
  function previewOf(e, url) {
    if (preview?.id !== e.id || preview.url !== url) {
      preview = {
        id: e.id,
        url,
        el: e.kind === 'video' ? h('video', { class: 'library__preview', src: url, controls: true, loop: true, preload: 'metadata' }) : h('img', { class: 'library__preview', src: url, alt: '' }),
      };
    }
    if (e.kind !== 'video') preview.el.alt = e.tags.join(', ');
    return preview.el;
  }

  function detail(e) {
    const url = lib.fileUrl(e);
    const suggested = [...new Set([...e.ai, ...L.suggestTags(e)])].filter((t) => !e.tags.includes(t)).slice(0, 10);
    const a = ai();
    const addTag = (t) => {
      const tag = L.normalizeTag(t);
      if (tag && !e.tags.includes(tag)) lib.update(e.id, { tags: [...e.tags, tag], ai: e.ai.filter((x) => x !== tag) });
    };
    return h(
      'aside',
      { class: 'library__detail', 'aria-label': 'Selected file' },
      h(
        'div',
        { class: 'library__detail-head' },
        h('strong', { class: 'library__name', translate: 'no', title: e.name, text: e.name }),
        h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close the details', 'data-key': `${k}library-detail-close`, onclick: () => ((selected = ''), draw()) }, icon('x')),
      ),
      previewOf(e, url),
      h(
        'p',
        { class: 'library__meta' },
        [formatBytes(e.size), e.w ? `${e.w}×${e.h}` : '', e.posted ? new Date(e.posted).toLocaleDateString() : ''].filter(Boolean).join(' · '),
      ),
      e.board && e.post
        ? h(
            'button',
            {
              type: 'button',
              class: 'link-btn library__source',
              title: 'Open the post it came from',
              'data-key': `${k}library-source`,
              onclick: () => o.onOpenPost({ board: e.board, thread: e.thread || e.post, no: e.post }),
            },
            icon('external'),
            e.thread && e.thread !== e.post ? `/${e.board}/ No. ${e.post} in No. ${e.thread}` : `/${e.board}/ No. ${e.post}`,
          )
        : e.folder
          ? h('p', { class: 'field__hint', translate: 'no', title: e.folder, text: `Imported from ${L.folderName(e.folder)}${e.from && e.from !== e.name ? ` · ${e.from}` : ''}` })
          : h('p', { class: 'field__hint', text: 'Imported: where it was posted is not known.' }),
      e.sub ? h('p', { class: 'library__sub', translate: 'no', text: e.sub }) : null,
      e.text ? h('p', { class: 'library__text', translate: 'no', text: e.text }) : null,

      h('h3', { class: 'library__h', text: 'Tags' }),
      h(
        'ul',
        { class: 'library__chips' },
        e.tags.map((t) =>
          h(
            'li',
            { class: 'library__chip' },
            h('span', { translate: 'no', text: t }),
            h('button', { type: 'button', class: 'library__chip-x', 'aria-label': `Remove the tag ${t}`, 'data-key': `${k}library-untag-${t}`, onclick: () => lib.update(e.id, { tags: e.tags.filter((x) => x !== t) }) }, icon('x')),
          ),
        ),
      ),
      h('input', {
        class: 'input',
        placeholder: 'Add tags (Enter; commas for several)',
        'aria-label': 'Add tags',
        'data-key': `${k}library-addtag`,
        onkeydown: (ev) => {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          const tags = ev.target.value.split(',').map(L.normalizeTag).filter((t) => t && !e.tags.includes(t));
          ev.target.value = '';
          if (tags.length) lib.update(e.id, { tags: [...e.tags, ...tags] });
        },
      }),
      suggested.length
        ? h(
            'div',
            { class: 'library__suggest' },
            h('span', { class: 'field__hint', text: 'Suggested:' }),
            suggested.map((t) =>
              h(
                'button',
                { type: 'button', class: `library__tag${e.ai.includes(t) ? ' library__tag--ai' : ''}`, title: e.ai.includes(t) ? 'Suggested by the AI' : 'From the thread and the file’s name', 'data-key': `${k}library-suggest-${t}`, onclick: () => addTag(t) },
                icon('plus'),
                h('span', { translate: 'no', text: t }),
              ),
            ),
          )
        : null,
      a.ready && e.kind !== 'video'
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn--sm',
              disabled: Boolean(busy),
              title: `${a.vision} looks at the picture, on this computer`,
              'data-key': `${k}library-ai-one`,
              onclick: async () => {
                busy = 'The AI is looking at the picture…';
                draw();
                try {
                  const tags = await lib.aiTags(e.id, a);
                  if (!tags.length) toast('The AI had no new tags.');
                } catch (err) {
                  toast(`AI tags failed: ${err?.message || err}`);
                }
                busy = '';
                draw();
              },
            },
            icon('sparkle'),
            'Suggest tags with AI',
          )
        : null,

      h('h3', { class: 'library__h', text: 'Collections' }),
      lib.collections().length
        ? h(
            'div',
            { class: 'library__collections' },
            lib.collections().map((c) =>
              h(
                'label',
                { class: 'checkline' },
                h('input', {
                  type: 'checkbox',
                  checked: e.collections.includes(c),
                  'data-key': `${k}library-col-${c}`,
                  onchange: (ev) => lib.update(e.id, { collections: ev.target.checked ? [...e.collections, c] : e.collections.filter((x) => x !== c) }),
                }),
                h('span', { translate: 'no', text: c }),
              ),
            ),
          )
        : null,
      h('input', {
        class: 'input',
        placeholder: 'New collection (Enter)',
        'aria-label': 'New collection',
        maxlength: '60',
        'data-key': `${k}library-newcol`,
        onkeydown: (ev) => {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          const c = lib.addCollection(ev.target.value);
          ev.target.value = '';
          if (c && !e.collections.includes(c)) lib.update(e.id, { collections: [...e.collections, c] });
        },
      }),

      h(
        'div',
        { class: 'library__detail-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn--danger',
            'data-key': `${k}library-delete`,
            onclick: async (ev) => {
              const ok = await confirmDialog({ title: 'Delete this file?', text: `“${e.name}” is deleted from the library folder for good.`, confirm: 'Delete', opener: ev.currentTarget });
              if (!ok) return;
              try {
                await lib.remove(e.id);
                selected = '';
                draw();
              } catch (err) {
                toast(`Couldn’t delete it: ${err?.message || err}`);
              }
            },
          },
          icon('trash'),
          'Delete',
        ),
      ),
    );
  }

  // ------------------------------------------------------ several at once

  function pickBar(all) {
    const shownList = L.filterItems(all, f).slice(0, shown);
    const ids = [...picked];
    const none = !ids.length;
    return h(
      'div',
      { class: 'library__pickbar', role: 'toolbar', 'aria-label': 'Picked files' },
      h('strong', { text: ids.length === 1 ? '1 picked' : `Picked ${ids.length}` }),
      h('button', { type: 'button', class: 'link-btn', 'data-key': `${k}library-pick-all`, onclick: () => (shownList.forEach((e) => picked.add(e.id)), draw()), text: 'Pick all shown' }),
      none ? null : h('button', { type: 'button', class: 'link-btn', 'data-key': `${k}library-pick-none`, onclick: () => (picked.clear(), draw()), text: 'Pick none' }),
      h('input', {
        class: 'input library__pick-tag',
        placeholder: 'Add tags to them (Enter)',
        'aria-label': 'Add tags to the picked files',
        disabled: none,
        'data-key': `${k}library-pick-tag`,
        onkeydown: (ev) => {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          const tags = ev.target.value.split(',').map(L.normalizeTag).filter(Boolean);
          if (!tags.length) return;
          lib.updateMany(ids, (e) => ({ tags: [...e.tags, ...tags] }));
          ev.target.value = '';
          toast(ids.length === 1 ? 'Tagged 1 file.' : `Tagged ${ids.length} files.`);
        },
      }),
      lib.collections().length
        ? select('library-pick-col', 'Add the picked files to a collection', '', [['', 'Add to collection…'], ...lib.collections().map((c) => [c, c])], (c) => {
            if (!c || none) return;
            lib.updateMany(ids, (e) => ({ collections: [...e.collections, c] }));
            toast(`Added to ${c}.`);
          })
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--sm btn--danger',
          disabled: none || Boolean(busy),
          'data-key': `${k}library-pick-remove`,
          onclick: async (ev) => {
            const ok = await confirmDialog({
              title: 'Remove the picked files?',
              text: ids.length === 1 ? '1 file is deleted from the library, with its tags. Files you imported stay where they were on your computer.' : `${ids.length} files are deleted from the library, with their tags. Files you imported stay where they were on your computer.`,
              confirm: 'Remove',
              opener: ev.currentTarget,
            });
            if (!ok) return;
            busy = 'Removing…';
            draw();
            const n = await lib.removeMany(ids);
            picked.clear();
            busy = '';
            selected = '';
            draw();
            toast(n === 1 ? 'Removed 1 file.' : `Removed ${n} files.`);
          },
        },
        icon('trash'),
        'Remove from library',
      ),
      h('button', { type: 'button', class: 'btn btn--sm', 'data-key': `${k}library-pick-done`, onclick: () => ((picking = false), picked.clear(), draw()), text: 'Done' }),
    );
  }

  // ------------------------------------------------------- look-alikes

  function lookalikes(all) {
    // found again only when the library changed, not on every draw
    if (lookCache.v !== lib.version() || lookCache.items !== all) {
      // found again only when the library changed: timed, at debug
      const t0 = performance.now();
      lookCache = { v: lib.version(), items: all, groups: L.lookalikeGroups(all) };
      log.debug('library', 'library.lookalikes', { items: all.length, groups: lookCache.groups.length, files: lookCache.groups.reduce((n, g) => n + g.length, 0), ms: Math.round(performance.now() - t0) });
    }
    const { groups } = lookCache;
    const missing = all.filter((e) => !e.dhash && (e.kind === 'image' || e.kind === 'gif')).length;
    return h(
      'div',
      { class: 'library__grid-wrap' },
      missing ? h('p', { class: 'field__hint', text: `Still looking at ${missing} pictures…` }) : null,
      !groups.length
        ? h('p', { class: 'state-line', text: 'No look-alikes: every picture is different.' })
        : groups.map((g, gi) =>
            h(
              'section',
              { class: 'library__group' },
              h(
                'div',
                { class: 'library__group-head' },
                h('span', { text: `${g.length} look alike` }),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn--sm',
                    title: 'Keeps the largest one, with every tag and collection of the others',
                    'data-key': `${k}library-dedupe-${gi}`,
                    onclick: (ev) => dedupe(g, ev.currentTarget),
                  },
                  'Keep the largest',
                ),
              ),
              h('ul', { class: 'library__grid' }, g.map((e) => tile(e, true))),
            ),
          ),
    );
  }

  async function dedupe(group, opener) {
    const [keep, ...others] = group;
    // only files that look like the one kept (the groups are made so)
    const rest = others.filter((e) => L.hamming(keep.dhash, e.dhash) <= L.LOOKALIKE_BITS);
    if (!rest.length) return;
    const ok = await confirmDialog({
      title: 'Delete the look-alikes?',
      text: rest.length === 1 ? `1 file is deleted for good; “${keep.name}” stays, with its tags.` : `${rest.length} files are deleted for good; “${keep.name}” stays, with their tags.`,
      confirm: 'Delete',
      opener,
    });
    if (!ok) return;
    log.info('library', 'library.dedupe', { group: group.length, deleting: rest.length });
    lib.update(keep.id, {
      tags: [...new Set([...keep.tags, ...rest.flatMap((e) => e.tags)])],
      collections: [...new Set([...keep.collections, ...rest.flatMap((e) => e.collections)])],
    });
    // one pass: one write and one redraw, not one per file
    try {
      const n = await lib.removeMany(rest.map((e) => e.id));
      if (n < rest.length) toast(rest.length - n === 1 ? 'Couldn’t delete 1 of them.' : `Couldn’t delete ${rest.length - n} of them.`);
    } catch (err) {
      log.warn('library', 'library.dedupe.failed', { kind: errorKind(err) });
      toast(`Couldn’t delete it: ${err?.message || err}`);
    }
  }

  // ------------------------------------------------------- long jobs

  async function runImport(files) {
    if (!files.length || busy) return;
    busy = 'Importing…';
    draw();
    const r = await lib.importFiles(files, {
      known: o.knownFiles(),
      onProgress: (done, total) => {
        busy = `Importing ${done} of ${total}…`;
        const b = node.querySelector('.library__busy');
        if (b) b.textContent = busy;
      },
    });
    busy = '';
    draw();
    const parts = [r.added === 1 ? '1 file imported' : `${r.added} files imported`];
    if (r.have) parts.push(r.have === 1 ? '1 was already there' : `${r.have} were already there`);
    if (r.skipped) parts.push(r.skipped === 1 ? '1 was not a picture or video' : `${r.skipped} were not pictures or videos`);
    if (r.failed.length) parts.push(`${r.failed.length} failed (${r.failed[0].message})`);
    toast(parts.join(' · '));
  }

  async function runFolderImport(src, deep) {
    if (busy) return;
    busy = 'Importing…';
    draw();
    let r;
    let again = false;
    try {
      const how = {
        known: o.knownFiles(),
        onProgress: (done, total) => {
          busy = total ? `Importing ${done} of ${total}…` : 'Copying the folder’s files…';
          const b = node.querySelector('.library__busy');
          if (b) b.textContent = busy;
        },
      };
      // no `deep`: a rescan, done as the folder was first imported. A folder
      // imported before is rescanned too (what it has is not copied again).
      again = deep === null || Boolean(lib.folderInfo(src));
      r = again ? await lib.rescanFolder(src, deep === null ? how : { ...how, deep }) : await lib.importFolder(src, { ...how, deep });
    } catch (e) {
      busy = '';
      draw();
      log.warn('library', 'library.folder.failed', { kind: errorKind(e), rescan: again });
      toast(`Couldn’t import the folder: ${e?.message || e}`);
      return;
    }
    busy = '';
    f.source = `dir:${src}`;
    shown = PAGE;
    draw();
    const parts = [again && !r.added ? 'Nothing new in the folder' : r.added === 1 ? '1 file imported' : `${r.added} files imported`];
    if (r.have) parts.push(r.have === 1 ? '1 was already there' : `${r.have} were already there`);
    if (r.more) parts.push('the folder has more: Rescan brings in the next ones');
    if (r.failed.length) parts.push(`${r.failed.length} failed (${r.failed[0].message})`);
    toast(parts.join(' · '));
  }

  /** The folder browser: go into folders, up, or to a place; import the
   *  folder shown (with its sub-folders, or without). */
  function browseFolders(opener) {
    let deep = true;
    let at = null; // the last answer from libraryBrowse
    let error = '';
    const body = h('div', { class: 'folder-pick__body' });
    const d = h(
      'dialog',
      { class: 'folder-pick', 'aria-label': 'Import a folder' },
      h(
        'div',
        { class: 'folder-pick__head' },
        h('strong', { text: 'Import a folder' }),
        h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close', 'data-key': `${k}folder-close`, onclick: () => finish() }, icon('x')),
      ),
      body,
    );
    function finish() {
      if (!d.isConnected) return;
      d.close();
      d.remove();
      opener?.isConnected && opener.focus({ preventScroll: true });
    }
    d.addEventListener('close', () => d.remove());
    async function go(path) {
      try {
        at = await lib.browse(path);
        error = '';
      } catch (e) {
        error = String(e?.message || e);
      }
      paint();
      body.querySelector('.folder-pick__dirs button, [data-key$="folder-up"]')?.focus({ preventScroll: true });
    }
    function crumbs(path) {
      const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
      const parts = path.split(sep).filter(Boolean);
      const out = [];
      let acc = '';
      parts.forEach((p, i) => {
        acc = sep === '/' ? `${acc}/${p}` : i === 0 ? `${p}\\` : `${acc.replace(/\\$/, '')}\\${p}`;
        const target = acc;
        out.push(h('button', { type: 'button', class: 'folder-pick__crumb', translate: 'no', 'data-key': `${k}folder-crumb-${i}`, onclick: () => go(target), text: p }));
        if (i < parts.length - 1) out.push(h('span', { class: 'folder-pick__sep', 'aria-hidden': 'true', text: '›' }));
      });
      if (sep === '/') out.unshift(h('button', { type: 'button', class: 'folder-pick__crumb', 'data-key': `${k}folder-crumb-root`, onclick: () => go('/'), text: '/' }));
      return out;
    }
    function paint() {
      if (!at) {
        body.replaceChildren(h('p', { class: error ? 'field__error' : 'state-line', text: error || 'Opening…' }));
        return;
      }
      body.replaceChildren(
        h(
          'div',
          { class: 'folder-pick__places' },
          at.places.map((p) => h('button', { type: 'button', class: `library__tag${p.path === at.path ? ' library__tag--on' : ''}`, 'data-key': `${k}folder-place-${p.name}`, onclick: () => go(p.path), text: p.name })),
        ),
        h(
          'nav',
          { class: 'folder-pick__path', 'aria-label': 'Folder path' },
          h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Up one folder', title: 'Up one folder', disabled: !at.parent, 'data-key': `${k}folder-up`, onclick: () => go(at.parent) }, icon('collapse')),
          crumbs(at.path),
        ),
        error ? h('p', { class: 'field__error', role: 'alert', text: error }) : '',
        at.dirs.length
          ? h(
              'ul',
              { class: 'folder-pick__dirs', 'aria-label': 'Folders inside' },
              at.dirs.map((x) =>
                h(
                  'li',
                  null,
                  h('button', { type: 'button', class: 'folder-pick__dir', translate: 'no', title: 'Open this folder', 'data-key': `${k}folder-dir-${x.name}`, onclick: () => go(x.path) }, icon('folder'), h('span', { text: x.name })),
                ),
              ),
            )
          : h('p', { class: 'field__hint', text: 'No folders inside.' }),
        h(
          'div',
          { class: 'folder-pick__foot' },
          h('span', { class: 'field__hint', text: at.media === 1 ? '1 picture or video right here' : `${at.media} pictures and videos right here` }),
          h(
            'label',
            { class: 'checkline' },
            h('input', { type: 'checkbox', checked: deep, 'data-key': `${k}folder-deep`, onchange: (e) => (deep = e.target.checked) }),
            h('span', { text: 'With its sub-folders' }),
          ),
          h('button', { type: 'button', class: 'btn', 'data-key': `${k}folder-cancel`, onclick: () => finish(), text: 'Cancel' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn--primary',
              'data-key': `${k}folder-import`,
              onclick: () => {
                const src = at.path;
                finish();
                runFolderImport(src, deep);
              },
            },
            icon('upload'),
            'Import this folder',
          ),
        ),
      );
    }
    paint();
    document.body.append(d);
    d.showModal();
    go('');
  }

  async function tagAll(list) {
    const a = ai();
    let done = 0;
    let failed = 0;
    let why = '';
    const t0 = performance.now();
    log.info('library', 'library.ai.started', { files: list.length, server: String(a?.kind || ''), model: String(a?.vision || '') });
    for (const [i, e] of list.entries()) {
      busy = `The AI is tagging ${i + 1} of ${list.length}…`;
      draw();
      try {
        const tags = await lib.aiTags(e.id, a);
        if (tags.length) {
          lib.update(e.id, { tags: [...e.tags, ...tags], ai: [] });
          done += 1;
        }
      } catch (err) {
        failed += 1;
        why = String(err?.message || err);
        // the server is down or the model missing: the rest would fail too
        if (failed >= 3 && !done) break;
      }
    }
    busy = '';
    draw();
    log.info('library', 'library.ai.finished', { files: list.length, tagged: done, failed, failKind: failed ? errorKind(why) : '', ms: Math.round(performance.now() - t0) });
    const text = done === 1 ? 'Tagged 1 picture.' : `Tagged ${done} pictures.`;
    toast(failed ? `${text} ${failed} failed: ${why}` : text);
  }

  draw();
  return { node, draw, select: (id) => ((selected = id), draw()) };
}
