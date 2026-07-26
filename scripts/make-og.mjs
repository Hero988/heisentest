// Renders scripts/og.html to public/og.png (1200x630).
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto("file://" + join(here, "og.html"));
await page.waitForTimeout(200);
await page.screenshot({ path: join(here, "..", "public", "og.png") });
await browser.close();
console.log("wrote public/og.png");
