import { expect, test } from "@playwright/test";
import {
  expectNoUnnamedButtons,
  gotoApp,
  loadSampleData,
  waitForCharts,
  watchForPageErrors
} from "./helpers";

test("redraws charts after a viewport resize", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await loadSampleData(page);
  await waitForCharts(page);

  const initialWidth = await page.locator("#usage-chart svg").first().evaluate(svg => svg.getBoundingClientRect().width);
  await page.setViewportSize({ width: 980, height: 720 });
  await expect.poll(() => page.locator("#usage-chart svg").first().evaluate(svg => svg.getBoundingClientRect().width)).not.toBe(initialWidth);
  await expect(page.locator("#usage-chart svg")).toHaveCount(3);
  await expect(page.locator("#monthly-bills-chart svg")).toBeVisible();
  watcher.assertNoErrors();
});

test("has accessible names and keyboard focus for core controls", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await expectNoUnnamedButtons(page);
  await expect(page.getByRole("button", { name: /theme/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import from extension" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load sample data" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear saved data" })).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.locator("#theme-toggle")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#file-input")).toBeFocused();

  await loadSampleData(page);
  await expectNoUnnamedButtons(page);
  await expect(page.getByLabel("Residence type")).toBeVisible();
  await expect(page.locator("#service-phase")).toBeVisible();
  await expect(page.getByLabel("Paperless billing credit")).toBeVisible();
  await expect(page.locator("#shift-percent")).toBeVisible();
  await expect(page.locator("#ev-count")).toBeVisible();
  watcher.assertNoErrors();
});
