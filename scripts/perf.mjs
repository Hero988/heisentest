// Measures real load + search performance on a generated large log file.
// Usage: node scripts/perf.mjs [sizeMB]  (default 500)
// Requires `npm run build` first; serves dist/ via `vite preview` externally
// or pass PERF_URL. Prints observed numbers — these are the only numbers
// allowed into README/marketing copy.

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sizeMB = Number(process.argv[2] ?? 500);
const dir = mkdtempSync(join(tmpdir(), "heisentest-perf-"));
const file = join(dir, `perf-${sizeMB}mb.log`);

console.log(`generating ~${sizeMB} MB log at ${file} …`);
const target = sizeMB * 1024 * 1024;
const stream = createWriteStream(file);
const base = Date.UTC(2026, 6, 1, 0, 0, 0);
let written = 0;
let i = 0;
const services = ["checkout", "payments", "auth", "inventory", "search"];
await new Promise((resolve, reject) => {
  stream.on("error", reject);
  function writeChunk() {
    let ok = true;
    while (ok && written < target) {
      const ts = new Date(base + i * 15).toISOString();
      const svc = services[i % services.length];
      let line;
      if (i % 1009 === 0) {
        line = `${ts} ERROR ${svc} - upstream timeout after 3000ms request_id=${i}\n`;
      } else if (i % 97 === 0) {
        line = `{"time":"${ts}","level":"warn","service":"${svc}","msg":"retrying request","attempt":2,"request_id":${i}}\n`;
      } else {
        line = `{"time":"${ts}","level":"info","service":"${svc}","msg":"request handled","latency_ms":${(i * 7) % 180},"request_id":${i}}\n`;
      }
      written += Buffer.byteLength(line);
      i++;
      ok = stream.write(line);
    }
    if (written >= target) stream.end(resolve);
    else stream.once("drain", writeChunk);
  }
  writeChunk();
});
const realMB = (statSync(file).size / 1024 / 1024).toFixed(1);
console.log(`generated ${realMB} MB, ${i.toLocaleString()} lines`);

console.log("starting preview server…");
const server = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", "4199", "--strictPort"], {
  cwd: join(import.meta.dirname, ".."),
  shell: true,
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:4199/");

const t0 = Date.now();
await page.locator('input[type="file"]').setInputFiles(file);
await page.locator(".log-row").first().waitFor({ timeout: 600_000 });
const loadMs = Date.now() - t0;
console.log(`LOAD: ${(loadMs / 1000).toFixed(1)}s to interactive workbench (${realMB} MB, ${i.toLocaleString()} lines)`);

// Level filter (typed-array scan, no text search)
const t1 = Date.now();
await page.locator(".chip", { hasText: "ERROR" }).click();
await page.locator(".search-count").waitFor({ timeout: 120_000 });
const levelMs = Date.now() - t1;
const levelCount = await page.locator(".search-count").innerText();
console.log(`LEVEL FILTER: ${(levelMs / 1000).toFixed(2)}s → ${levelCount.trim()}`);
await page.locator(".chip", { hasText: "ERROR" }).click(); // clear
await page.locator(".search-count").waitFor({ state: "hidden", timeout: 120_000 });

// Text search across every line — wait for the fresh count, not the stale one
const t2 = Date.now();
await page.getByRole("searchbox").fill("request_id=1009000");
await page.locator(".search-count", { hasText: "1 /" }).waitFor({ timeout: 300_000 });
const searchMs = Date.now() - t2;
const searchCount = await page.locator(".search-count").innerText();
console.log(`TEXT SEARCH: ${(searchMs / 1000).toFixed(2)}s → ${searchCount.trim()} (includes 180ms debounce)`);

await browser.close();
server.kill();
console.log("done");
