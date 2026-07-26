import { expect, test } from "@playwright/test";

test("the app works fully offline after one visit", async ({ page, context }) => {
  // First visit online: service worker installs and caches the app.
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 15_000,
  });

  // Now cut the network entirely and reload.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Open huge log files", {
    timeout: 15_000,
  });

  // The analyzer itself must work with no network at all.
  await page.getByRole("button", { name: /load the sample incident/i }).click();
  await expect(page.locator(".log-row").first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("searchbox").fill("outofmemoryerror");
  await expect(page.locator(".search-count")).toContainText("1 /", { timeout: 10_000 });

  await context.setOffline(false);
});
