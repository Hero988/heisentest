// Renders scripts/og.html to public/og.png (1200x630).
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();

// Site OG card (1200x630) — used by X/link previews via the meta tags.
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto("file://" + join(here, "og.html"));
await page.waitForTimeout(200);
await page.screenshot({ path: join(here, "..", "public", "og.png") });
console.log("wrote public/og.png");

// GitHub social preview (1280x640) — operator uploads in repo Settings.
const gh = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await gh.goto("file://" + join(here, "og.html"));
await gh.waitForTimeout(200);
await gh.screenshot({ path: join(here, "..", ".private", "launch-assets", "github-social-preview.png") });
console.log("wrote .private/launch-assets/github-social-preview.png");

await browser.close();
