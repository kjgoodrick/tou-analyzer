import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  clearSavedData,
  expectMetric,
  gotoApp,
  loadSampleData,
  waitForCharts,
  watchForPageErrors
} from "./helpers";

test("imports a small CSV fixture and shows expected summary values", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await page.locator("#file-input").setInputFiles(path.join(import.meta.dirname, "fixtures/small-usage.csv"));

  await expect(page.locator("#import-status")).toContainText("6 intervals loaded from small-usage.csv", { timeout: 45_000 });
  await expect(page.locator("#dashboard")).toBeVisible();
  await expectMetric(page, "On-peak", "8.3%", "3 kWh");
  await expectMetric(page, "Off-peak", "91.7%", "33 kWh");
  await expect(page.locator("#date-range")).toContainText("Jul 2, 2026");
  await expect(page.locator("#date-range")).toContainText("Aug 1, 2026");
  await waitForCharts(page);
  watcher.assertNoErrors();
});

test("cycles the theme button through dark and system themes", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await page.emulateMedia({ colorScheme: "light" });
  await gotoApp(page);

  const root = page.locator("html");
  const toggle = page.locator("#theme-toggle");
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveAttribute("data-theme-choice", "system");
  await expect(toggle).toHaveAttribute("aria-label", "System theme. Switch to dark theme");

  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-theme-choice", "dark");
  await expect(toggle).toHaveAttribute("aria-label", "Dark theme. Return to system theme");

  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveAttribute("data-theme-choice", "system");
  await expect(toggle).toHaveAttribute("aria-label", "System theme. Switch to dark theme");
  watcher.assertNoErrors();
});

test("restores saved sample data after reload and clears back to empty state", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await clearSavedData(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#dashboard")).toBeHidden();

  await loadSampleData(page);
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.locator("#import-status")).toContainText(/intervals loaded from schedule-1-residential-average-2021-2023-duckdb-wasm\.parquet/i, { timeout: 45_000 });
  await expect(page.locator("#dashboard")).toBeVisible();

  await page.getByRole("button", { name: "Clear saved data" }).click();
  await expect(page.locator("#dashboard")).toBeHidden();
  await expect(page.getByText("No data loaded. Import a local file or load the sample dataset.")).toBeVisible();
  watcher.assertNoErrors();
});

test("shows a user-facing error for a malformed CSV upload", async ({ page }) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await page.locator("#file-input").setInputFiles(path.join(import.meta.dirname, "fixtures/malformed-usage.csv"));

  await expect(page.locator("#import-status")).toHaveText("No valid usage rows were found.", { timeout: 45_000 });
  await expect(page.locator("#import-status")).toHaveClass(/error/);
  await expect(page.locator("#dashboard")).toBeHidden();
  watcher.assertNoErrors();
});
