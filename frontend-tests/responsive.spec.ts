import { expect, test } from "@playwright/test";
import { gotoApp, loadSampleData, waitForCharts, watchForPageErrors } from "./helpers";

test("keeps import controls, charts, and tables usable on a mobile viewport", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await expect(page.getByRole("button", { name: "Load sample data" })).toBeVisible();
  await expect(page.locator("#file-input")).toBeVisible();

  await loadSampleData(page);
  await waitForCharts(page);

  await expect(page.locator("#headline-metrics .metric")).toHaveCount(5);
  await expect(page.locator("#usage-chart svg")).toHaveCount(3);
  await expect(page.locator("#monthly-bills-chart svg")).toBeVisible();
  await expect(page.locator("#monthly-table")).toBeVisible();
  await expect(page.locator("#line-table")).toBeVisible();

  await page.locator("#monthly-table").evaluate(element => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(page.locator("#monthly-table table")).toBeVisible();
  watcher.assertNoErrors();
});
