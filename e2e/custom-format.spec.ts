import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An invented format no auto-detector could know. */
function weirdFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "heisentest-fmt-"));
  const path = join(dir, "invented.log");
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    const mm = String(Math.floor(i / 60)).padStart(2, "0");
    const ss = String(i % 60).padStart(2, "0");
    const level = i === 120 ? "KABOOM" : i % 17 === 0 ? "MEH" : "OKAY";
    lines.push(`26.07.2026 02:${mm}:${ss} <> ${level} <> unit-${i % 4} <> event number ${i}`);
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("teach an invented format: pattern, preview, apply, persist", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(weirdFile());
  await expect(page.locator(".log-row").first()).toBeVisible({ timeout: 15_000 });

  // Auto-parse found timestamps (generic tier) but no levels — ERROR chip absent.
  await expect(page.locator(".chip", { hasText: "ERROR" })).toHaveCount(0);

  // Open the format dialog for the file.
  await page.getByRole("button", { name: /adjust parsing/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Teach the format.
  await page.locator(".fmt-pattern").fill(
    String.raw`^(?<timestamp>[\d.]+ [\d:]+) <> (?<level>\w+) <> (?<service>\S+) <> (?<message>.*)$`,
  );
  await page.locator(".fmt-tsfmt input").first().fill("%d.%m.%Y %H:%M:%S");

  // Live preview shows matches before applying.
  await expect(page.locator(".fmt-preview-head")).toContainText("8/8", { timeout: 5_000 });

  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });

  // Custom levels aren't in the built-in table — map them via the level facet?
  // KABOOM/MEH/OKAY are unknown words, so level chips stay absent, but service
  // facets and messages now come from the named groups.
  await expect(page.locator(".chip", { hasText: "unit-0" })).toBeVisible();
  const firstMsg = page.locator(".log-row .log-msg").first();
  await expect(firstMsg).toContainText("event number 0");
});

test("custom level tokens map onto canonical levels", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(weirdFile());
  await expect(page.locator(".log-row").first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /adjust parsing/i }).click();
  await page.locator(".fmt-pattern").fill(
    String.raw`^(?<timestamp>[\d.]+ [\d:]+) <> (?<level>\w+) <> (?<service>\S+) <> (?<message>.*)$`,
  );
  await page.locator(".fmt-tsfmt input").first().fill("%d.%m.%Y %H:%M:%S");
  await page
    .locator(".fmt-tsfmt input")
    .nth(1)
    .fill("error=KABOOM warn=MEH info=OKAY");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });

  // The invented severity words now behave as first-class levels.
  await expect(page.locator(".chip", { hasText: "ERROR" })).toContainText("1");
  await page.locator(".chip", { hasText: "ERROR" }).click();
  await expect(page.locator(".log-row").first()).toContainText("event number 120");
});
