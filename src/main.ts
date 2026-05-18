import "@fontsource/playfair-display/latin-700.css";
import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-600.css";
import "@fontsource/source-serif-4/latin-700.css";
import "./styles.css";
import { compareMonthlyUsage, compareRates, runMonthlyScenario, runScenario } from "./analysis";
import { bridgeConfigured, requestCsvFromExtension } from "./extensionBridge";
import { formatDateRange, formatKwh, formatMoney, formatNumber, formatPercent, monthName } from "./format";
import { importPublishedProfile, PUBLISHED_PROFILES } from "./publishedProfiles";
import { DEFAULT_BILLING_ASSUMPTIONS, RIDER_DETAILS } from "./rates";
import { clearCurrentImport, loadCurrentImport, saveCurrentImport } from "./storage";
import { renderSummaryCharts, renderUsageChart } from "./charts";
import { importUsageFile, warmUsageDatabase } from "./mosaicData";
import {
  BillingAssumptions,
  CustomerClassId,
  ImportResult,
  RateComparison,
  ScenarioInputs,
  ScenarioResult
} from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app root");
const appRoot = app;

let currentImport: ImportResult | null = null;
let assumptions: BillingAssumptions = structuredClone(DEFAULT_BILLING_ASSUMPTIONS);
let scenarioInputs: ScenarioInputs = {
  shiftOnPeakPercent: 20,
  evCount: 1,
  evAnnualMiles: 12000,
  evMilesPerKwh: 3.4,
  evOffPeakShare: 0.9
};
let resizeHandlerBound = false;
let resizeRedrawTimer: number | null = null;
let chartRenderGeneration = 0;

type ThemeChoice = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function oppositeTheme(theme: ResolvedTheme): ResolvedTheme {
  return theme === "dark" ? "light" : "dark";
}

function setTheme(theme: ThemeChoice): void {
  localStorage.setItem("tou-theme", theme);
  const resolved = theme === "system" ? systemTheme() : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeChoice = theme;
  updateThemeButton(theme);
}

function selectedTheme(): ThemeChoice {
  const value = localStorage.getItem("tou-theme");
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function nextTheme(theme: ThemeChoice): ThemeChoice {
  const system = systemTheme();
  if (theme === "system") return oppositeTheme(system);
  return oppositeTheme(theme) === system ? "system" : oppositeTheme(theme);
}

function themeLabel(theme: ThemeChoice): string {
  const system = systemTheme();
  if (theme === "system") return `System theme. Switch to ${oppositeTheme(system)} theme`;
  const next = nextTheme(theme);
  if (next === "system") return `${theme[0].toUpperCase()}${theme.slice(1)} theme. Return to system theme`;
  return `${theme[0].toUpperCase()}${theme.slice(1)} theme. Switch to ${next} theme`;
}

function themeButtonIcon(theme: ThemeChoice): string {
  if (theme === "light") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M19.5 14.7A7.7 7.7 0 0 1 9.3 4.5a8.2 8.2 0 1 0 10.2 10.2Z"></path></svg>`;
  }
  if (theme === "dark") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"></circle><path d="M12 2.8v2.4M12 18.8v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"></path></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.4" cy="8.5" r="2.7" fill="currentColor" stroke="none"></circle><path d="M8.4 2.7v1.4M8.4 12.9v1.4M3.3 8.5H1.9M14.9 8.5h-1.4M4.8 4.9l-1-1M12 12.1l1 1M12 4.9l1-1M4.8 12.1l-1 1"></path><path fill="currentColor" stroke="none" d="M20.4 16.1a4.6 4.6 0 0 1-6.1-6.1 5 5 0 1 0 6.1 6.1Z"></path></svg>`;
}

function updateThemeButton(theme: ThemeChoice): void {
  const button = document.querySelector<HTMLButtonElement>("#theme-toggle");
  if (!button) return;
  button.dataset.themeChoice = theme;
  button.innerHTML = `${themeButtonIcon(theme)}<span class="sr-only">${themeLabel(theme)}</span>`;
  button.setAttribute("aria-label", themeLabel(theme));
  button.title = themeLabel(theme);
}

function customerParts(customerClass: CustomerClassId): { dwelling: "single" | "multi"; phase: "single" | "three" } {
  return {
    dwelling: customerClass.startsWith("MULTI") ? "multi" : "single",
    phase: customerClass.endsWith("THREE_PHASE") ? "three" : "single"
  };
}

function customerClassFromParts(dwelling: string, phase: string): CustomerClassId {
  if (dwelling === "multi" && phase === "three") return "MULTI_FAMILY_THREE_PHASE";
  if (dwelling === "multi") return "MULTI_FAMILY_SINGLE_PHASE";
  if (phase === "three") return "SINGLE_FAMILY_THREE_PHASE";
  return "SINGLE_FAMILY_SINGLE_PHASE";
}

function rootMarkup(): string {
  return `
    <header class="topbar">
      <div>
        <h1>Time-of-Use Rate Analyzer</h1>
      </div>
      <div class="top-actions">
        <button id="theme-toggle" class="theme-toggle" type="button"></button>
      </div>
    </header>

    <main>
      <section id="import" class="band import-band">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Private import</p>
            <h2>Load interval data</h2>
          </div>
          <p id="privacy-status" class="privacy-pill">All calculations run in this browser.</p>
        </div>
        <div class="import-grid">
          <label class="file-drop">
            <input id="file-input" type="file" accept=".csv,.parquet" />
            <span class="file-title">CSV or Parquet</span>
            <span class="file-note">CSV and Parquet interval files are supported.</span>
          </label>
          <div class="import-actions">
            <button id="extension-import" type="button">Import from extension</button>
            <button id="sample-import" type="button">Load sample data</button>
            <button id="clear-data" class="ghost" type="button">Clear saved data</button>
          </div>
          <div id="import-status" class="import-status"></div>
        </div>
      </section>

      <section id="dashboard" class="dashboard hidden">
        <section id="summary" class="band summary-band">
          <p class="eyebrow">Summary</p>
          <p id="summary-copy" class="summary-copy">
            This tool compares your actual usage against Schedule 1 TOU, the time-of-use rate offered by Utah's largest electric utility.
            Start with the <a href="#rate-comparison">rate comparison</a> to see if TOU already saves you money.
            Check <a href="#assumptions">billing assumptions</a> to confirm your home type, then explore the
            <a href="#usage">load profile</a>, <a href="#monthly-charts">monthly charts</a>,
            and <a href="#annual-charts">annual charts</a>.
            The <a href="#scenario">load shifting</a> section shows how moving evening usage or charging an EV off-peak could increase your savings.
            Review the <a href="#details">detailed tables</a> for month-by-month line items.
          </p>
        </section>

        <section id="rate-comparison" class="band headline-band">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Rate comparison</p>
              <h2>Should you consider TOU?</h2>
              <h2 id="recommendation-title">Recommendation</h2>
            </div>
            <div class="period-summary">
              <p class="eyebrow">Considered period</p>
              <p id="date-range" class="muted"></p>
            </div>
          </div>
          <div id="headline-metrics" class="metric-grid"></div>
          <p id="recommendation-copy" class="recommendation-copy"></p>
        </section>

        <section id="tou-explainer" class="band prose-band">
          <div class="prose-grid">
            <div>
              <h2>How TOU works</h2>
              <p>
                Schedule 1 TOU charges more from 6 p.m. to 10 p.m. on non-holiday weekdays and less during every other hour. The important question is what proportion of your total energy lands in that evening window. For many households it is 10-20%; your data shows <span id="tou-share-anchor">--</span>.
              </p>
            </div>
            <div>
              <h2>How the recommendation is set</h2>
              <p>
                Percent savings are determined from the standard and TOU bill totals. At 5% or better the site marks TOU as a good fit. At -2% or worse it marks TOU as poor. Everything between those marks could work, but it deserves a closer look at whether evening loads can shift off-peak or might shift unfavorably.
              </p>
            </div>
          </div>
        </section>

        <section id="assumptions" class="band assumptions-band">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Billing assumptions</p>
              <h2>Customer and tax inputs</h2>
            </div>
          </div>
          <div class="controls-grid">
            <label>
              <span>Residence type</span>
              <select id="dwelling-type">
                <option value="single">Single-family</option>
                <option value="multi">Multi-family</option>
              </select>
            </label>
            <label>
              <span class="label-row">
                Service phase
                <button
                  class="info-tip"
                  type="button"
                  aria-label="Nearly all homes are single phase. If your home is three phase, it will be indicated on your bill."
                  data-tooltip="Nearly all homes are single phase. If your home is three phase, it will be indicated on your bill."
                >i</button>
              </span>
              <select id="service-phase">
                <option value="single">Single-phase</option>
                <option value="three">Three-phase</option>
              </select>
            </label>
            <label>
              <span>Utah sales tax</span>
              <span class="percent-input">
                <input id="utah-tax" type="number" step="0.01" />
              </span>
            </label>
            <label>
              <span>Municipal tax</span>
              <span class="percent-input">
                <input id="municipal-tax" type="number" step="0.01" />
              </span>
            </label>
            <label>
              <span class="label-row">
                Paperless billing credit
                <button
                  class="info-tip"
                  type="button"
                  aria-label="Paperless billing applies a monthly credit of 50 cents."
                  data-tooltip="Paperless billing applies a monthly credit of 50 cents."
                >i</button>
              </span>
              <span id="paperless-credit" class="segmented" role="group" aria-label="Paperless billing credit">
                <button type="button" data-value="yes">Yes</button>
                <button type="button" data-value="no">No</button>
              </span>
            </label>
          </div>
        </section>

        <section id="usage" class="band chart-band">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Interval load profile</p>
              <h2>Energy usage over time</h2>
              <p class="section-note">The filled area traces energy over time. Use the lower timelines to select a broad range and a detailed range; scroll over the plot area to zoom, and drag a selected range to pan.</p>
            </div>
          </div>
          <div id="usage-chart" class="chart-stack"></div>
        </section>

        <section id="charts" class="band chart-band">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Cost and energy</p>
              <h2>Monthly and annual charts</h2>
            </div>
          </div>
          <div class="chart-grid">
            <div id="cost-charts" class="chart-card wide">
              <div class="chart-title-row">
                <h3 id="monthly-charts">Monthly bill comparison</h3>
                <div class="legend-stack" aria-label="Bill chart legend">
                  <div class="mini-legend legend-colors">
                    <span><i class="swatch standard"></i> Standard</span>
                    <span><i class="swatch tou"></i> TOU</span>
                  </div>
                  <div class="mini-legend legend-hatches">
                    <span><i class="swatch missing"></i> Missing data</span>
                    <span><i class="swatch tou-higher"></i> TOU higher</span>
                  </div>
                </div>
              </div>
              <div id="monthly-bills-chart" class="chart-slot"></div>
            </div>
            <div class="chart-card wide">
              <div class="chart-title-row">
                <h3>Monthly total energy</h3>
                <div class="legend-stack" aria-label="Energy chart legend">
                  <div class="mini-legend legend-colors">
                    <span><i class="swatch standard"></i> Off-peak</span>
                    <span><i class="swatch tou"></i> On-peak</span>
                  </div>
                  <div class="mini-legend legend-hatches">
                    <span><i class="swatch missing"></i> Missing data</span>
                    <span><i class="swatch tou-higher"></i> TOU higher</span>
                  </div>
                </div>
              </div>
              <div id="monthly-peak-chart" class="chart-slot"></div>
            </div>
            <div class="chart-card wide">
              <div class="chart-title-row">
                <div>
                  <h3>Monthly load profile by hour</h3>
                  <p class="chart-note">Average energy [kWh] by hour of day for each calendar month. Hatched amber bands mark the 6-10 p.m. TOU window.</p>
                </div>
              </div>
              <div id="monthly-profile-chart" class="chart-slot profile-slot"></div>
            </div>
            <div id="annual-charts" class="chart-card annual">
              <div class="chart-title-row">
                <h3>Annual bill comparison</h3>
                <div class="mini-legend" aria-label="Annual bill chart legend">
                  <span><i class="swatch standard"></i> Standard</span>
                  <span><i class="swatch tou"></i> TOU</span>
                </div>
              </div>
              <div id="annual-bills-chart" class="chart-slot"></div>
            </div>
            <div class="chart-card annual">
              <div class="chart-title-row">
                <h3>Annual total energy</h3>
                <div class="mini-legend" aria-label="Annual peak chart legend">
                  <span><i class="swatch standard"></i> Off-peak</span>
                  <span><i class="swatch tou"></i> On-peak</span>
                </div>
              </div>
              <div id="annual-peak-chart" class="chart-slot"></div>
            </div>
          </div>
        </section>

        <section id="scenario" class="band scenario-band">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Projection</p>
              <h2>Load shifting and EV charging</h2>
            </div>
          </div>
          <div class="scenario-layout">
            <div class="controls-grid">
              <label>
                <span class="label-row">
                  Shifted on-peak load
                  <button
                    class="info-tip"
                    type="button"
                    aria-label="Fraction of the current on-peak kWh moved to off-peak hours; 100% leaves no on-peak energy."
                    data-tooltip="Fraction of the current on-peak kWh moved to off-peak hours; 100% leaves no on-peak energy."
                  >i</button>
                </span>
                <input id="shift-percent" type="range" min="0" max="100" step="1" />
                <strong id="shift-label"></strong>
              </label>
              <label>
                <span class="label-row">
                  Future EVs
                  <button
                    class="info-tip"
                    type="button"
                    aria-label="Use this for EVs you may add later. Do not include EV charging already present in the loaded usage data."
                    data-tooltip="Use this for EVs you may add later. Do not include EV charging already present in the loaded usage data."
                  >i</button>
                </span>
                <input id="ev-count" type="number" step="1" min="0" />
              </label>
              <label>
                <span>Miles per EV per year</span>
                <input id="ev-miles" type="number" step="500" min="0" />
              </label>
              <label>
                <span>EV miles per kWh</span>
                <input id="ev-efficiency" type="number" step="0.1" min="1" />
              </label>
              <label class="ev-offpeak-control">
                <span>EV off-peak charging %</span>
                <input id="ev-offpeak" type="range" min="0" max="100" step="1" />
                <strong id="ev-offpeak-label"></strong>
              </label>
            </div>
            <div id="scenario-metrics" class="metric-grid scenario-metrics"></div>
          </div>
        </section>

        <section id="details" class="band table-band">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Detailed data</p>
              <h2>Monthly bills and line items</h2>
            </div>
          </div>
          <div id="monthly-table" class="table-wrap"></div>
          <div id="line-table" class="table-wrap"></div>
        </section>
      </section>
    </main>
  `;
}

function bindStaticEvents(): void {
  bindResizeRedraw();
  const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
  if (themeToggle) {
    updateThemeButton(selectedTheme());
    themeToggle.addEventListener("click", () => setTheme(nextTheme(selectedTheme())));
  }
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  themeMedia.addEventListener("change", () => {
    if (selectedTheme() === "system") setTheme("system");
    else updateThemeButton(selectedTheme());
  });

  document.querySelector<HTMLInputElement>("#file-input")?.addEventListener("change", async event => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await runImport(async () => {
      return importUsageFile(file);
    });
    input.value = "";
  });

  document.querySelector<HTMLButtonElement>("#extension-import")?.addEventListener("click", () => {
    runImport(requestCsvFromExtension);
  });

  document.querySelector<HTMLButtonElement>("#sample-import")?.addEventListener("click", () => {
    runImport(() => importPublishedProfile(PUBLISHED_PROFILES[0]));
  });

  document.querySelector<HTMLButtonElement>("#clear-data")?.addEventListener("click", async () => {
    await clearCurrentImport();
    currentImport = null;
    render();
  });
}

function bindResizeRedraw(): void {
  if (resizeHandlerBound) return;
  resizeHandlerBound = true;
  window.addEventListener("resize", () => {
    if (!currentImport) return;
    if (resizeRedrawTimer) window.clearTimeout(resizeRedrawTimer);
    resizeRedrawTimer = window.setTimeout(() => {
      resizeRedrawTimer = null;
      renderDashboard(true);
    }, 160);
  });
}

function bindDashboardEvents(): void {
  const parts = customerParts(assumptions.customerClass);
  const dwelling = document.querySelector<HTMLSelectElement>("#dwelling-type");
  const phase = document.querySelector<HTMLSelectElement>("#service-phase");
  const updateCustomerClass = () => {
    if (!dwelling || !phase) return;
    assumptions = { ...assumptions, customerClass: customerClassFromParts(dwelling.value, phase.value) };
    renderDashboard();
  };
  if (dwelling) {
    dwelling.value = parts.dwelling;
    dwelling.addEventListener("change", updateCustomerClass);
  }
  if (phase) {
    phase.value = parts.phase;
    phase.addEventListener("change", updateCustomerClass);
  }

  bindSegmented("#paperless-credit", assumptions.paperlessCredit < 0 ? "yes" : "no", value => {
    assumptions = { ...assumptions, paperlessCredit: value === "yes" ? -0.5 : 0 };
    renderDashboard();
  });
  bindNumber("#municipal-tax", assumptions.taxJurisdictions[0].rate * 100, value => {
    assumptions.taxJurisdictions[0] = { ...assumptions.taxJurisdictions[0], rate: value / 100 };
    renderDashboard();
  });
  bindNumber("#utah-tax", assumptions.taxJurisdictions[1].rate * 100, value => {
    assumptions.taxJurisdictions[1] = { ...assumptions.taxJurisdictions[1], rate: value / 100 };
    renderDashboard();
  });

  bindNumber("#ev-miles", scenarioInputs.evAnnualMiles, value => {
    scenarioInputs = { ...scenarioInputs, evAnnualMiles: value };
    renderScenarioOnly();
  }, "input");
  bindNumber("#ev-count", scenarioInputs.evCount, value => {
    scenarioInputs = { ...scenarioInputs, evCount: Math.max(0, Math.floor(value)) };
    renderScenarioOnly();
  }, "input");
  bindNumber("#ev-efficiency", scenarioInputs.evMilesPerKwh, value => {
    scenarioInputs = { ...scenarioInputs, evMilesPerKwh: value };
    renderScenarioOnly();
  }, "input");

  const shift = document.querySelector<HTMLInputElement>("#shift-percent");
  if (shift) {
    shift.value = String(scenarioInputs.shiftOnPeakPercent);
    shift.addEventListener("input", () => {
      scenarioInputs = { ...scenarioInputs, shiftOnPeakPercent: Number(shift.value) };
      renderScenarioOnly();
    });
  }
  const offPeak = document.querySelector<HTMLInputElement>("#ev-offpeak");
  if (offPeak) {
    offPeak.value = String(scenarioInputs.evOffPeakShare * 100);
    offPeak.addEventListener("input", () => {
      scenarioInputs = { ...scenarioInputs, evOffPeakShare: Number(offPeak.value) / 100 };
      renderScenarioOnly();
    });
  }
}

function bindNumber(
  selector: string,
  value: number,
  onChange: (value: number) => void,
  eventName: "change" | "input" = "change"
): void {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) return;
  input.value = String(value);
  input.addEventListener(eventName, () => {
    const next = Number(input.value);
    if (Number.isFinite(next)) onChange(next);
  });
}

function bindSegmented(selector: string, value: string, onChange: (value: string) => void): void {
  const group = document.querySelector<HTMLElement>(selector);
  if (!group) return;
  const buttons = [...group.querySelectorAll<HTMLButtonElement>("button[data-value]")];
  const setSelected = (next: string) => {
    for (const button of buttons) {
      const selected = button.dataset.value === next;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  };
  setSelected(value);
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const next = button.dataset.value;
      if (!next) return;
      setSelected(next);
      onChange(next);
    });
  }
}

async function runImport(loader: () => Promise<ImportResult>): Promise<void> {
  chartRenderGeneration += 1;
  setImportStatus("Loading data...");
  try {
    const result = await loader();
    if (!importIntervalCount(result)) throw new Error("No valid usage rows were found.");
    currentImport = result;
    await saveCurrentImport(result);
    render();
  } catch (error) {
    setImportStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function setImportStatus(message: string, isError = false): void {
  const status = document.querySelector<HTMLDivElement>("#import-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function render(): void {
  appRoot.innerHTML = rootMarkup();
  bindStaticEvents();
  setTheme(selectedTheme());
  const extensionButton = document.querySelector<HTMLButtonElement>("#extension-import");
  if (extensionButton && !bridgeConfigured()) {
    extensionButton.disabled = true;
    extensionButton.title = "Set VITE_UTILITY_ENERGY_DOWNLOADER_EXTENSION_ID for this deployment to enable extension import.";
  }

  const dashboard = document.querySelector<HTMLElement>("#dashboard");
  if (!currentImport) {
    setImportStatus("No data loaded. Import a local file or load the sample dataset.");
    dashboard?.classList.add("hidden");
    return;
  }

  dashboard?.classList.remove("hidden");
  const clipped = currentImport.negativeRowsClipped
    ? ` ${formatKwh(currentImport.kwhClippedToZero)} from ${currentImport.negativeRowsClipped} negative rows was clipped to zero.`
    : "";
  setImportStatus(
    `${formatNumber(importIntervalCount(currentImport))} intervals loaded from ${currentImport.sourceName}. Saved locally in this browser.${clipped}`
  );
  bindDashboardEvents();
  renderDashboard();
}

function renderDashboard(redrawCharts = true): void {
  if (!currentImport) return;
  const comparison = compareCurrentImport(currentImport);
  const scenario = scenarioForCurrentImport(currentImport);

  renderHeadline(comparison);
  renderScenario(scenario);
  renderTables(comparison);

  if (redrawCharts) {
    const chartRun = chartRenderGeneration + 1;
    chartRenderGeneration = chartRun;
    const isCurrentChartRun = () => chartRenderGeneration === chartRun;
    const chartScope = `run_${chartRun}`;
    const usageChart = document.querySelector<HTMLElement>("#usage-chart");
    if (usageChart) {
      renderUsageChart(usageChart, currentImport, isCurrentChartRun, chartScope).catch(error => {
        if (!isCurrentChartRun()) return;
        usageChart.textContent = error instanceof Error ? error.message : String(error);
      });
    }
    const slots = {
      monthlyBills: requiredSlot("#monthly-bills-chart"),
      annualBills: requiredSlot("#annual-bills-chart"),
      monthlyPeak: requiredSlot("#monthly-peak-chart"),
      annualPeak: requiredSlot("#annual-peak-chart"),
      monthlyProfile: requiredSlot("#monthly-profile-chart")
    };
    renderSummaryCharts(comparison, slots, currentImport, chartScope, isCurrentChartRun).catch(error => {
      if (!isCurrentChartRun()) return;
      for (const slot of Object.values(slots)) {
        slot.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  }
}

function renderScenarioOnly(): void {
  if (!currentImport) return;
  renderScenario(scenarioForCurrentImport(currentImport));
}

function importIntervalCount(result: ImportResult): number {
  return result.usageSummary?.intervalCount ?? result.rows.length;
}

function compareCurrentImport(result: ImportResult): RateComparison {
  if (result.monthlyUsage?.length && result.usageSummary) {
    return compareMonthlyUsage(result.monthlyUsage, result.usageSummary, assumptions);
  }
  return compareRates(result.rows, assumptions);
}

function scenarioForCurrentImport(result: ImportResult): ScenarioResult {
  if (result.monthlyUsage?.length && result.usageSummary) {
    return runMonthlyScenario(result.monthlyUsage, result.usageSummary, scenarioInputs, assumptions);
  }
  return runScenario(result.rows, scenarioInputs, assumptions);
}

function requiredSlot(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing chart slot ${selector}`);
  return element;
}

function renderHeadline(comparison: RateComparison): void {
  const { overall } = comparison;
  const title = document.querySelector<HTMLElement>("#recommendation-title");
  if (title) {
    title.textContent = recommendationHeading(overall);
    title.className = `recommendation-title ${overall.recommendation.kind}`;
  }

  const dateRange = document.querySelector<HTMLElement>("#date-range");
  if (dateRange) {
    const formattedRange = formatDateRange(overall.loadedStart, overall.loadedEnd);
    const match = formattedRange.match(/^(.*) \((.*)\)$/);
    dateRange.innerHTML = match
      ? `${match[1]}<br><span>${match[2]}</span>`
      : formattedRange;
  }

  const metrics = document.querySelector<HTMLElement>("#headline-metrics");
  if (metrics) {
    metrics.innerHTML = [
      metric("Savings", formatHeadlineSavings(overall.savings), formatPercent(overall.savingsPercent), "metric-savings"),
      metric("Standard cost", formatMoney(overall.standardTotal), "Schedule 1"),
      metric("TOU cost", formatMoney(overall.touTotal), "Schedule 1 TOU"),
      metric("On-peak", formatPercent(overall.onPeakKwh / overall.totalKwh), formatKwh(overall.onPeakKwh)),
      metric("Off-peak", formatPercent(overall.offPeakKwh / overall.totalKwh), formatKwh(overall.offPeakKwh))
    ].join("");
  }

  const touShareAnchor = document.querySelector<HTMLElement>("#tou-share-anchor");
  if (touShareAnchor) {
    touShareAnchor.textContent = formatPercent(overall.onPeakKwh / overall.totalKwh);
  }

  const copy = document.querySelector<HTMLElement>("#recommendation-copy");
  if (copy) copy.textContent = overall.recommendation.message;
}

function formatHeadlineSavings(value: number): string {
  if (Math.abs(value) <= 10) return formatMoney(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function recommendationHeading(overall: RateComparison["overall"]): string {
  if (overall.recommendation.kind === "good") return "TOU looks like a good fit";
  if (overall.recommendation.kind === "poor") return "TOU does not look like a good fit";
  return overall.savings >= 0 ? "TOU could work and already saves money" : "TOU could work with changes";
}

function renderScenario(scenario: ScenarioResult): void {
  const shiftLabel = document.querySelector<HTMLElement>("#shift-label");
  if (shiftLabel) shiftLabel.textContent = `${scenarioInputs.shiftOnPeakPercent}%`;
  const evLabel = document.querySelector<HTMLElement>("#ev-offpeak-label");
  if (evLabel) evLabel.textContent = `${Math.round(scenarioInputs.evOffPeakShare * 100)}%`;

  const metrics = document.querySelector<HTMLElement>("#scenario-metrics");
  if (!metrics) return;
  const overall = scenario.shiftedComparison.overall;
  metrics.innerHTML = [
    metric("Scenario fit", overall.recommendation.label, formatPercent(overall.savingsPercent)),
    metric(
      `Scenario savings ${infoButton(
        "Scenario savings includes shifted existing load and shifted new EV load."
      )}`,
      formatMoney(overall.savings),
      `${formatKwh(scenario.shiftedKwh)} shifted`
    ),
    metric("New EV energy", formatKwh(scenario.evAnnualKwh), `${scenarioInputs.evCount} future EV${scenarioInputs.evCount === 1 ? "" : "s"}, ${formatKwh(scenario.evMonthlyKwh)} per month`),
    metric("EV TOU savings", formatMoney(scenario.evTouSavings), "Energy-only annual estimate")
  ].join("");
}

function metric(label: string, value: string, note: string, className = ""): string {
  return `
    <div class="metric ${className}">
      <span class="metric-label">${label}</span>
      <strong>${value}</strong>
      <small>${note}</small>
    </div>
  `;
}

function infoButton(tooltip: string): string {
  return `<button class="info-tip" type="button" aria-label="${tooltip}" data-tooltip="${tooltip}">i</button>`;
}

function renderTables(comparison: RateComparison): void {
  const monthly = document.querySelector<HTMLElement>("#monthly-table");
  if (monthly) {
    monthly.innerHTML = `
      <h3 class="table-title">Monthly comparison</h3>
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>Savings</th>
            <th>Total [kWh]</th>
            <th>On-peak</th>
            <th>Standard</th>
            <th>TOU</th>
          </tr>
        </thead>
        <tbody>
          ${comparison.monthly
            .map(
              row => `
                <tr class="year-${row.month.slice(0, 4)}">
                  <td>${monthName(row.month)}</td>
                  <td class="${row.savings >= 0 ? "savings-positive" : "savings-negative"}">${formatMoney(row.savings)} (${formatPercent(row.savingsPercent)})</td>
                  <td>${formatNumber(row.totalKwh, 1)}</td>
                  <td>${formatPercent(row.onPeakKwh / row.totalKwh)}</td>
                  <td>${formatMoney(row.standard.total)}</td>
                  <td>${formatMoney(row.tou.total)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  const lineTable = document.querySelector<HTMLElement>("#line-table");
  if (lineTable) {
    lineTable.innerHTML = `
      <h3 class="table-title">Bill line items</h3>
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th class="schedule-cell">Schedule</th>
            <th>Base energy</th>
            <th>
              <span class="label-row table-label-row">
                Riders
                <button class="info-tip rider-tip" type="button" aria-label="Rider schedule details" aria-describedby="rider-popover">i</button>
              </span>
            </th>
            <th>Taxes</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${comparison.monthly
            .map((row, index) => billGroup(row.month, index, row.standard, row.tou))
            .join("")}
        </tbody>
      </table>
      <div id="rider-popover" class="rider-popover" role="tooltip" hidden>
        <div class="rider-popover-title">Rider schedules</div>
        <div class="rider-popover-table">
          ${RIDER_DETAILS.map(
            rider => `<div><span><b>${rider.name}</b><em>${rider.friendlyName}</em></span><strong>${rider.rateLabel}</strong></div>`
          ).join("")}
        </div>
      </div>
    `;
    bindRiderPopover(lineTable);
  }
}

function bindRiderPopover(container: HTMLElement): void {
  const button = container.querySelector<HTMLButtonElement>(".rider-tip");
  const popover = container.querySelector<HTMLDivElement>("#rider-popover");
  if (!button || !popover) return;

  const placePopover = () => {
    popover.hidden = false;
    popover.classList.add("visible");
    button.setAttribute("aria-expanded", "true");
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const gap = 10;
    const viewportPadding = 12;
    const centeredLeft = buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2;
    const left = Math.max(viewportPadding, Math.min(centeredLeft, window.innerWidth - popoverRect.width - viewportPadding));
    const top = Math.max(viewportPadding, buttonRect.top - popoverRect.height - gap);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  };

  const hidePopover = () => {
    popover.classList.remove("visible");
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  button.setAttribute("aria-expanded", "false");
  button.addEventListener("mouseenter", placePopover);
  button.addEventListener("focus", placePopover);
  button.addEventListener("click", event => {
    event.preventDefault();
    if (popover.hidden) placePopover();
    else hidePopover();
  });
  button.addEventListener("mouseleave", hidePopover);
  button.addEventListener("blur", hidePopover);
  button.addEventListener("keydown", event => {
    if (event.key === "Escape") hidePopover();
  });
}

function billGroup(
  month: string,
  index: number,
  standard: RateComparison["monthly"][number]["standard"],
  tou: RateComparison["monthly"][number]["tou"]
): string {
  return `
    <tr class="bill-group ${index % 2 ? "odd" : "even"}">
      <td rowspan="2" class="month-cell">${monthName(month)}</td>
      ${billCells("Standard", standard)}
    </tr>
    <tr class="bill-group ${index % 2 ? "odd" : "even"}">
      ${billCells("TOU", tou)}
    </tr>
  `;
}

function billCells(schedule: string, bill: RateComparison["monthly"][number]["standard"]): string {
  const riders =
    bill.schedule_94 +
    bill.schedule_98 +
    bill.schedule_193 +
    bill.schedule_196 +
    bill.schedule_198 +
    bill.schedule_97 +
    bill.schedule_91;
  return `
      <td class="schedule-cell">${schedule}</td>
      <td>${formatMoney(bill.baseEnergyCharge)}</td>
      <td>${formatMoney(riders)}</td>
      <td>${formatMoney(bill.taxes)}</td>
      <td>${formatMoney(bill.total)}</td>
  `;
}

async function init(): Promise<void> {
  setTheme(selectedTheme());
  warmUsageDatabase().catch(() => undefined);
  currentImport = await loadCurrentImport().catch(() => null);
  render();
}

init().catch(error => {
  appRoot.textContent = error instanceof Error ? error.message : String(error);
});
