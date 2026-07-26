import { test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("format dialog screenshot", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "heisentest-shot-"));
  const path = join(dir, "invented.log");
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) {
    lines.push(
      `26.07.2026 02:${String(i).padStart(2, "0")}:00 <> ${i === 30 ? "KABOOM" : "OKAY"} <> unit-${i % 3} <> event number ${i}`,
    );
  }
  writeFileSync(path, lines.join("\n") + "\n");
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(path);
  await page.locator(".log-row").first().waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: /adjust parsing/i }).click();
  await page.locator(".fmt-pattern").fill(
    String.raw`^(?<timestamp>[\d.]+ [\d:]+) <> (?<level>\w+) <> (?<service>\S+) <> (?<message>.*)$`,
  );
  await page.locator(".fmt-tsfmt input").first().fill("%d.%m.%Y %H:%M:%S");
  await page.locator(".fmt-tsfmt input").nth(1).fill("error=KABOOM info=OKAY");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/shots/format-dialog.png" });
});
