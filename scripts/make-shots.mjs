// Produces the polished launch screenshots (light + dark) used by the README
// and attachable to posts. Requires `npm run build` first.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
mkdirSync(join(root, "docs"), { recursive: true });

const server = spawn(
  "npx",
  ["vite", "preview", "--host", "127.0.0.1", "--port", "4198", "--strictPort"],
  { cwd: root, shell: true, stdio: "ignore" },
);
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch();
for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  await page.goto("http://127.0.0.1:4198/");
  await page.getByRole("button", { name: /load the sample incident/i }).click();
  await page.locator(".log-row").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(root, "docs", `workbench-${scheme}.png`) });
  await page.close();
  console.log(`wrote docs/workbench-${scheme}.png`);
}
await browser.close();
server.kill();
