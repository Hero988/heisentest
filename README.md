# heisentest

**Open huge log files in your browser. Nothing is uploaded.**

Drop a log file onto **[heisentest.com](https://heisentest.com)** — hundreds of megabytes,
a gigabyte — and read it like a story: a timeline of every event with errors in red,
filter-as-you-type, stack traces folded into the error that threw them, and several files
merged onto one clock so cause and effect line up.

Everything runs locally in your browser tab. **Your file never leaves your machine** — the
app works with wifi off (it's an offline-capable PWA), and you can watch the network tab
stay empty while you analyze.

## Measured performance

Numbers observed on a real machine (Chromium, mid-range Windows laptop), generated
mixed-format log files:

| File | Time to interactive | Level filter | Text search (find 1 line) |
|---|---|---|---|
| 500 MB · 3.97M lines | 7.5 s | 0.13 s | 1.8 s |
| 1 GB · 7.9M lines | 15.6 s | 0.11 s | 2.9 s |

Reproduce with `node scripts/perf.mjs 1000` after `npm run build`.

## What it understands

Format detection runs **per line**, so mixed files work — JSON lines interleaved with stray
prints still parse.

- **JSON lines** — pino/winston (Node), zap/logrus (Go), structlog (Python), Docker's
  json-file driver; string or numeric levels, the common timestamp/message/service key spellings
- **logfmt** — Heroku, go-kit style `key=value` lines
- **nginx / Apache access logs** — combined log format; 5xx→ERROR, 4xx→WARN
- **syslog** — classic `Jul 26 02:14:04 host proc[pid]:` lines
- **Generic framework layouts** — `timestamp LEVEL logger - message` shapes from Java, Python,
  .NET, Go, Rails and friends
- **Stack traces** — `at …`, `Caused by:`, tracebacks and goroutine dumps fold into their
  opening error row
- **Anything else** — still loads as searchable text; unrecognized lines are never dropped

Levels are normalized across ecosystems (`SEVERE`, `emerg`, `panic`, pino's `50` → ERROR).
Timestamps are normalized to one clock for the timeline and cross-file merge.

## How it stays private

There is no backend. The file is streamed and indexed inside a Web Worker in your tab: raw
bytes in append-only blocks, columns (time/level/service) in typed arrays, rows materialized
only when they scroll into view. The site is a static bundle (~300 KiB precached); after one
visit it opens and analyzes files with no network at all.

## Develop

```
npm install
npm run dev      # local dev server
npm run check    # typecheck + unit tests + build
npm run e2e      # Playwright suite (desktop + mobile, incl. offline proof)
```

The engine is dependency-free TypeScript in `src/engine/` — line splitting, format
detection, timestamp parsing, the columnar store — each with unit tests in `test/`.

## Roadmap

- Live tail of a growing local file
- Custom timestamp/format patterns ("my format looks like this")
- SQL over logs (DuckDB-WASM, lazy-loaded)
- Shareable investigations for teams — saved views, annotations, links (this will be the
  paid tier, planned at £79/month per team; the analyzer itself stays free forever)

## License

Apache-2.0. The `ee/` directory (currently empty) is reserved for the future team tier and
is not covered by the core license grant.
