# CloverEye API probe

User-Agent: `CloverEye/0.1.0`  
Board: /g/  
Requests: 7

| # | URL | Status | Bytes | ms | Conditional | Notes |
|---|---|---|---|---|---|---|
| 1 | https://a.4cdn.org/boards.json | 200 | 35514 | 117 | no | cache-control max-age=5, stale-while-revalidate=10 |
| 2 | https://a.4cdn.org/g/catalog.json | 200 | 378827 | 73 | no | cache-control max-age=5, stale-while-revalidate=10 |
| 3 | https://a.4cdn.org/g/catalog.json | 304 | 0 | 13 | yes | cache-control max-age=5, stale-while-revalidate=10 |
| 4 | https://a.4cdn.org/g/threads.json | 200 | 8867 | 66 | no | cache-control max-age=5, stale-while-revalidate=10 |
| 5 | https://a.4cdn.org/g/thread/&lt;no&gt;.json | 200 | 4901 | 72 | no | cache-control max-age=5, stale-while-revalidate=10 |
| 6 | https://a.4cdn.org/g/thread/&lt;no&gt;.json | 304 | 0 | 10 | yes | cache-control max-age=5, stale-while-revalidate=10 |
| 7 | https://a.4cdn.org/g/archive.json | 200 | 15471 | 88 | no | cache-control max-age=5, stale-while-revalidate=10 |

## Outcome

- boards.json: New
- catalog: New
- catalog again (conditional, 304 expected): NotModified
- threads.json: New
- thread &lt;no&gt;: New
- thread &lt;no&gt; again after 10.2 s (conditional): NotModified
- archive.json: New

## Thumbnails for the image-path check

Taken from the catalog above (no extra request). Thread numbers and image
names are replaced with placeholders so this file does not point at real
posts:

- https://i.4cdn.org/g/&lt;tim1&gt;s.jpg
- https://i.4cdn.org/g/&lt;tim2&gt;s.jpg
- https://i.4cdn.org/g/&lt;tim3&gt;s.jpg
- https://i.4cdn.org/g/&lt;tim4&gt;s.jpg
- https://i.4cdn.org/g/&lt;tim5&gt;s.jpg

## Image path check (webview-style `<img>` loads)

Run 4 November 2026, about 07:48 CST, right after the probe above. A local
page on `127.0.0.1:7398` inserted the five thumbnails listed above as plain
`<img>` tags, one per second, in Playwright's bundled Chromium (headless,
User-Agent `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like
Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36`, Referer
`http://127.0.0.1:7398/`). Status taken from Playwright `response` events.

| # | URL | Status | t (s) | Content-Type | Decoded |
|---|---|---|---|---|---|
| 1 | https://i.4cdn.org/g/&lt;tim1&gt;s.jpg | 200 | 0.2 | image/jpeg | 250×135 |
| 2 | https://i.4cdn.org/g/&lt;tim2&gt;s.jpg | 200 | 1.0 | image/jpeg | 249×250 |
| 3 | https://i.4cdn.org/g/&lt;tim3&gt;s.jpg | 200 | 2.0 | image/jpeg | 250×187 |
| 4 | https://i.4cdn.org/g/&lt;tim4&gt;s.jpg | 200 | 3.0 | image/jpeg | 250×250 |
| 5 | https://i.4cdn.org/g/&lt;tim5&gt;s.jpg | 200 | 4.0 | image/jpeg | 250×140 |

An earlier attempt of the same page a minute before loaded the same five
thumbnails, but its result-collection step crashed (a script bug), so its
statuses were not recorded. In all, the image host saw 10 thumbnail requests
from this machine in about two minutes; none of the recorded ones was a 429.

## Conclusion

- **JSON path (Rust core, honest `CloverEye/0.1.0` User-Agent): works.** 7
  requests, 7 good answers (5 × 200, 2 × 304 on the conditional repeats),
  no 429, no `Retry-After`. `If-Modified-Since` behaves as SCOPE §1 says, so
  thread polling will mostly cost 304s.
- **Image path (webview `<img>`, normal browser User-Agent): works.** 5 of 5
  thumbnails returned 200 at one per second. The earlier 429 came from a
  single `curl` with a bare `Mozilla/5.0` UA and a `Range` header; a real
  browser engine loading thumbnails the normal way was not limited.
- So the honest UA can stay for the JSON path for now, and images should keep
  loading through the webview rather than through the Rust core.
- **This is one data point, not the C0 gate.** SCOPE §7 asks for a week of
  normal browsing with zero 429s. Not tested here: full-size images and WebM
  from `i.4cdn.org`, the real Tauri webview (WebKitGTK, whose User-Agent and
  Referer, `tauri://localhost`, differ from headless Chromium), longer
  sessions, and other boards.
