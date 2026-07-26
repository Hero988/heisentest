import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe("hero", () => {
  test("loads with the drop zone and no third-party requests", async ({ page }) => {
    const offsite: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.hostname !== "127.0.0.1") offsite.push(req.url());
    });
    await page.goto("/");
    await expect(page).toHaveTitle(/heisentest/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Open huge log files");
    await expect(page.getByText("Drop a log file anywhere")).toBeVisible();
    expect(offsite).toEqual([]);
  });
});

test.describe("sample incident", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /load the sample incident/i }).click();
    await expect(page.locator(".log-row").first()).toBeVisible({ timeout: 15_000 });
  });

  test("shows the workbench: files, levels, timeline, rows", async ({ page }) => {
    await expect(page.locator(".chip", { hasText: "checkout-app.log" })).toBeVisible();
    await expect(page.locator(".chip", { hasText: "gateway-access.log" })).toBeVisible();
    await expect(page.locator(".chip", { hasText: "ERROR" })).toBeVisible();
    await expect(page.locator(".tl-canvas")).toBeVisible();
    await expect(page.locator(".rail-privacy")).toContainText("Nothing leaves this tab");
  });

  test("search narrows to the OOM and the drawer shows the folded stack trace", async ({ page }) => {
    await page.getByRole("searchbox").fill("outofmemoryerror");
    await expect(page.locator(".search-count")).toContainText("1 /", { timeout: 10_000 });
    const row = page.locator(".log-row").first();
    await expect(row).toContainText("OutOfMemoryError");
    await expect(row.locator(".log-fold")).toContainText("+3 lines");
    await row.click();
    await expect(page.locator(".drawer-raw")).toContainText("CartSerializer.write");
    await page.keyboard.press("Escape");
    await expect(page.locator(".drawer")).toHaveCount(0);
  });

  test("level filter isolates errors from both files", async ({ page }) => {
    await page.locator(".chip", { hasText: "ERROR" }).click();
    await expect(page.locator(".search-count")).toBeVisible();
    // every visible row shows the ERROR badge
    const badges = page.locator(".log-row .log-level");
    const count = await badges.count();
    expect(count).toBeGreaterThan(3);
    for (let i = 0; i < Math.min(count, 8); i++) {
      await expect(badges.nth(i)).toHaveText("ERROR");
    }
  });

  test("analysis makes zero network requests", async ({ page }) => {
    const offsite: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.hostname !== "127.0.0.1") offsite.push(req.url());
    });
    await page.getByRole("searchbox").fill("checkout");
    await page.locator(".chip", { hasText: "WARN" }).click();
    await page.waitForTimeout(800);
    expect(offsite).toEqual([]);
  });
});

test.describe("real file drop", () => {
  test("parses a generated JSONL file via the file picker", async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "heisentest-e2e-"));
    const path = join(dir, "generated.jsonl");
    const lines: string[] = [];
    const base = Date.UTC(2026, 6, 1, 12, 0, 0);
    for (let i = 0; i < 50_000; i++) {
      const level = i % 997 === 0 ? "error" : i % 31 === 0 ? "warn" : "info";
      lines.push(
        `{"time":"${new Date(base + i * 20).toISOString()}","level":"${level}","service":"svc-${i % 5}","msg":"request ${i} handled"}`,
      );
    }
    writeFileSync(path, lines.join("\n"));

    await page.goto("/");
    const input = page.locator('input[type="file"]');
    await input.setInputFiles(path);
    await expect(page.locator(".log-row").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".rail-note")).toContainText("50,000 lines");
    await page.getByRole("searchbox").fill("request 42 handled");
    await expect(page.locator(".search-count")).toContainText("1 /", { timeout: 10_000 });
  });
});
