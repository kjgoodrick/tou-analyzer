import { expect, type Page } from "@playwright/test";

interface CapturedIssue {
  message: string;
  source: "console" | "pageerror";
}

export interface ErrorWatcher {
  assertNoErrors(): void;
  errors(): CapturedIssue[];
}

export function watchForPageErrors(page: Page): ErrorWatcher {
  const errors: CapturedIssue[] = [];

  page.on("console", message => {
    if (message.type() === "error") {
      errors.push({ source: "console", message: message.text() });
    }
  });

  page.on("pageerror", error => {
    errors.push({ source: "pageerror", message: error.message });
  });

  return {
    assertNoErrors() {
      expect(errors, errors.map(error => `[${error.source}] ${error.message}`).join("\n")).toEqual([]);
    },
    errors() {
      return [...errors];
    }
  };
}

export async function gotoApp(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Time-of-Use Rate Analyzer" })).toBeVisible();
}

export async function loadSampleData(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Load sample data" }).click();
  await expect(page.locator("#import-status")).toContainText(/intervals loaded from/i, { timeout: 45_000 });
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#recommendation-title")).toHaveText(/TOU/i);
}

export async function waitForCharts(page: Page): Promise<void> {
  await expect(page.locator("#usage-chart .plot")).toHaveCount(3, { timeout: 45_000 });
  await expect(page.locator("#usage-chart svg")).toHaveCount(3);

  for (const selector of [
    "#monthly-bills-chart svg",
    "#monthly-peak-chart svg",
    "#monthly-profile-chart svg",
    "#annual-bills-chart svg",
    "#annual-peak-chart svg"
  ]) {
    await expect(page.locator(selector)).toBeVisible({ timeout: 45_000 });
  }
}

export async function setInputValue(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).evaluate(
    (element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value
  );
}

export async function interactWithUsageChart(page: Page): Promise<void> {
  const topPlot = page.locator("#usage-chart .plot").first();
  await expect(topPlot).toBeVisible();
  const box = await topPlot.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const x = box.x + box.width * 0.55;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -420);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#usage-chart svg")).toHaveCount(3);
}

export interface ScrollPerformanceMetrics {
  durationMs: number;
  frameCount: number;
  averageFrameGapMs: number;
  maxFrameGapMs: number;
  overBudgetFrameCount: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  maxLongTaskMs: number;
  scrollHeight: number;
  viewportHeight: number;
  scrollDistance: number;
}

export async function startScrollMetrics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const perfWindow = window as Window & {
      __touScrollMetrics?: {
        frames: number[];
        longTasks: number[];
        observer?: PerformanceObserver;
      };
    };
    const metrics = { frames: [] as number[], longTasks: [] as number[], observer: undefined as PerformanceObserver | undefined };
    perfWindow.__touScrollMetrics = metrics;

    let lastFrame = performance.now();
    const tick = (now: number) => {
      metrics.frames.push(now - lastFrame);
      lastFrame = now;
      if (perfWindow.__touScrollMetrics === metrics) {
        window.requestAnimationFrame(tick);
      }
    };
    window.requestAnimationFrame(tick);

    try {
      metrics.observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          metrics.longTasks.push(entry.duration);
        }
      });
      metrics.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Not all browser builds expose longtask entries.
    }
  });
}

export async function scrollThroughPage(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const root = document.scrollingElement ?? document.documentElement;
    const maxScroll = Math.max(0, root.scrollHeight - window.innerHeight);
    const start = performance.now();

    for (let y = 0; y <= maxScroll; y += 180) {
      window.scrollTo(0, y);
      await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
    }

    window.scrollTo(0, maxScroll);
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
    return performance.now() - start;
  });
}

export async function collectScrollMetrics(page: Page, durationMs: number): Promise<ScrollPerformanceMetrics> {
  return page.evaluate(duration => {
    const perfWindow = window as Window & {
      __touScrollMetrics?: {
        frames: number[];
        longTasks: number[];
        observer?: PerformanceObserver;
      };
    };
    const metrics = perfWindow.__touScrollMetrics ?? { frames: [], longTasks: [] };
    metrics.observer?.disconnect();
    delete perfWindow.__touScrollMetrics;

    const frames = metrics.frames.slice(1);
    const longTasks = metrics.longTasks;
    const root = document.scrollingElement ?? document.documentElement;
    const averageFrameGapMs = frames.length
      ? frames.reduce((sum, value) => sum + value, 0) / frames.length
      : 0;
    const maxFrameGapMs = frames.length ? Math.max(...frames) : 0;

    return {
      durationMs: duration,
      frameCount: frames.length,
      averageFrameGapMs,
      maxFrameGapMs,
      overBudgetFrameCount: frames.filter(value => value > 50).length,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((sum, value) => sum + value, 0),
      maxLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
      scrollHeight: root.scrollHeight,
      viewportHeight: window.innerHeight,
      scrollDistance: Math.max(0, root.scrollHeight - window.innerHeight)
    };
  }, durationMs);
}
