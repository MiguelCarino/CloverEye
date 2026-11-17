// The ui/ folder served from disk inside the browser, at https://ce.test/,
// for the e2e passes: no local server or port is needed, and every other
// host is refused (and counted). Set BASE_URL to use a running server
// instead (then nothing is routed).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui');
export const HOST = 'https://ce.test/';
/** Where the pages are opened: BASE_URL, or the disk under HOST. */
export const BASE = process.env.BASE_URL || HOST;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.gif': 'image/gif' };

/** Routes a browser context's requests to the ui/ folder (unless BASE_URL
 *  names a server). Returns the list of outside URLs refused. */
export async function serveUi(ctx) {
  const outside = [];
  if (process.env.BASE_URL) return outside;
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== HOST.slice(0, -1)) {
      outside.push(url.href);
      return route.abort();
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '') || 'index.html';
    const file = join(UI, rel);
    if (!file.startsWith(UI) || !existsSync(file) || statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  return outside;
}

/** A file of the UI as text (the page's own copy when BASE_URL is set). */
export async function uiText(page, rel) {
  if (process.env.BASE_URL) return (await page.request.get(`${BASE}${rel}`)).text();
  return readFileSync(join(UI, rel), 'utf8');
}
