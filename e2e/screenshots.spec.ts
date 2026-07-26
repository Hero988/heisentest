import { test } from "@playwright/test";

const shots = "test-results/shots";

for (const scheme of ["light", "dark"] as const) {
  test(`hero ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/hero-${scheme}-${test.info().project.name}.png`, fullPage: true });
  });

  test(`workbench ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await page.getByRole("button", { name: /load the sample incident/i }).click();
    await page.locator(".log-row").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/workbench-${scheme}-${test.info().project.name}.png` });
  });
}

test("workbench with drawer open", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /load the sample incident/i }).click();
  await page.locator(".log-row").first().waitFor({ timeout: 15_000 });
  await page.getByRole("searchbox").fill("outofmemoryerror");
  await page.locator(".search-count").waitFor(); // query settled before clicking
  await page.locator(".log-row").first().click();
  await page.locator(".drawer-raw").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/drawer-${test.info().project.name}.png` });
});
