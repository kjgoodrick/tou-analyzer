import { expect, test } from "@playwright/test";
import {
  gotoApp,
  interactWithUsageChart,
  loadSampleData,
  setInputValue,
  waitForCharts,
  watchForPageErrors
} from "./helpers";

test("renders the empty import state with extension import disabled", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);

  await expect(page.getByText("No data loaded. Import a local file or load the sample dataset.")).toBeVisible();
  await expect(page.locator("#dashboard")).toBeHidden();
  await expect(page.getByRole("button", { name: "Import from extension" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Load sample data" })).toBeEnabled();
  watcher.assertNoErrors();
});

test("loads sample data and renders dashboard charts and tables", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await loadSampleData(page);
  await waitForCharts(page);

  await expect(page.locator("#headline-metrics .metric")).toHaveCount(5);
  await expect(page.locator("#scenario-metrics .metric")).toHaveCount(4);
  await expect.poll(() => page.locator("#monthly-table tbody tr").count()).toBeGreaterThanOrEqual(12);
  await expect.poll(() => page.locator("#line-table tbody tr").count()).toBeGreaterThanOrEqual(24);
  watcher.assertNoErrors();
});

test("updates billing and scenario controls without navigation errors", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await loadSampleData(page);

  const headline = page.locator("#headline-metrics");
  const scenarioMetrics = page.locator("#scenario-metrics");
  const originalHeadline = await headline.innerText();
  const originalScenario = await scenarioMetrics.innerText();

  await page.locator("#dwelling-type").selectOption("multi");
  await expect.poll(() => headline.innerText()).not.toBe(originalHeadline);

  await setInputValue(page, "#shift-percent", "45");
  await expect(page.locator("#shift-label")).toHaveText("45%");
  await expect.poll(() => scenarioMetrics.innerText()).not.toBe(originalScenario);

  const scenarioAfterShift = await scenarioMetrics.innerText();
  await setInputValue(page, "#ev-count", "2");
  await setInputValue(page, "#ev-miles", "14000");
  await setInputValue(page, "#ev-offpeak", "80");
  await expect(page.locator("#ev-offpeak-label")).toHaveText("80%");
  await expect.poll(() => scenarioMetrics.innerText()).not.toBe(scenarioAfterShift);
  watcher.assertNoErrors();
});

test("keeps the usage chart rendered after zooming and panning", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await loadSampleData(page);
  await waitForCharts(page);
  await interactWithUsageChart(page);

  await expect(page.locator("#usage-chart .plot")).toHaveCount(3);
  watcher.assertNoErrors();
});
