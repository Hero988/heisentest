// Local-only check against a real file on this machine (never committed data).
// Usage: node scripts/verify-user-file.mjs "C:\path\to\file"
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const file = process.argv[2];
if (!file) throw new Error("pass a file path");

const root = join(import.meta.dirname, "..");
const server = spawn(
  "npx",
  ["vite", "preview", "--host", "127.0.0.1", "--port", "4197", "--strictPort"],
  { cwd: root, shell: true, stdio: "ignore" },
);
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://127.0.0.1:4197/");
await page.locator('input[type="file"]').setInputFiles(file);
await page.locator(".log-row").first().waitFor({ timeout: 60_000 });

const note = await page.locator(".rail-note").innerText();
console.log("rail:", note.replace(/\n/g, " "));
const timeline = await page.locator(".tl-canvas").count();
console.log("timeline rendered:", timeline === 1);
const levels = await page.locator("#root .level-chip, .chip").allInnerTexts();
console.log("chips:", levels.slice(0, 10).join(" | "));
const firstRow = await page.locator(".log-row").first().innerText();
console.log("first row:", firstRow.replace(/\s+/g, " ").slice(0, 160));
await page.locator(".log-row").first().click();
await page.locator(".drawer-fields").waitFor({ timeout: 10_000 });
const fieldKeys = await page.locator(".drawer-field dt").allInnerTexts();
console.log("detail fields:", fieldKeys.slice(0, 12).join(", "));
await page.screenshot({ path: "test-results/shots/user-file.png" });
await browser.close();
server.kill();
console.log("done — screenshot at test-results/shots/user-file.png");
