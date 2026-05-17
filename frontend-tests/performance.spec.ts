import { expect, test } from "@playwright/test";
import {
  collectScrollMetrics,
  gotoApp,
  loadSampleData,
  scrollThroughPage,
  startScrollMetrics,
  waitForCharts,
  watchForPageErrors
} from "./helpers";

test("reports dashboard scroll performance @performance", async ({ page }, testInfo) => {
  const watcher = watchForPageErrors(page);

  await gotoApp(page);
  await loadSampleData(page);
  await waitForCharts(page);

  await startScrollMetrics(page);
  const durationMs = await scrollThroughPage(page);
  const metrics = await collectScrollMetrics(page, durationMs);
  const report = {
    ...metrics,
    errors: watcher.errors()
  };

  await testInfo.attach("scroll-performance.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json"
  });

  expect(metrics.scrollDistance).toBeGreaterThan(0);
  expect(metrics.frameCount).toBeGreaterThan(0);
  watcher.assertNoErrors();
});
