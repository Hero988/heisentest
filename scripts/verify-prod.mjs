// Post-deploy production check: the real site must run the full loop.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("https://heisentest.com/", { waitUntil: "domcontentloaded" });
const h1 = await page.locator("h1").innerText();
console.log("h1:", h1.replace(/\n/g, " "));
await page.getByRole("button", { name: /load the sample incident/i }).click();
await page.locator(".log-row").first().waitFor({ timeout: 20_000 });
console.log("sample loaded, rows visible");
await page.getByRole("searchbox").fill("outofmemoryerror");
await page.locator(".search-count", { hasText: "1 /" }).waitFor({ timeout: 10_000 });
console.log("search found the OOM");
await page.locator(".log-row").first().click();
await page
  .locator(".drawer-raw", { hasText: "CartSerializer.write" })
  .waitFor({ timeout: 10_000 });
console.log("drawer shows stack trace: true");
const guides = await page.goto("https://heisentest.com/guides/open-large-log-file.html");
console.log("guide page status:", guides.status());
await browser.close();
console.log("PRODUCTION VERIFIED");
