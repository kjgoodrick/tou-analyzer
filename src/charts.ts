import * as vg from "@uwdata/vgplot";
import { formatNumber } from "./format";
import { TABLE_USAGE } from "./data";
import { ensureUsageTable, loadObjectsTable, queryJson, execSql } from "./mosaicData";
import { ImportResult, RateComparison } from "./types";

const TABLE_MONTHLY_BILLS = "monthly_bills";
const TABLE_ANNUAL_BILLS = "annual_bills";
const TABLE_MONTHLY_PEAK = "monthly_peak";
const TABLE_ANNUAL_PEAK = "annual_peak";
const TABLE_MONTHLY_PROFILE = "monthly_load_profile";
const TABLE_MONTHLY_PROFILE_MONTHS = "monthly_load_profile_months";
const TABLE_MONTHLY_PROFILE_PEAK = "monthly_load_profile_peak";
const TABLE_MONTHLY_PROFILE_EMPTY = "monthly_load_profile_empty";
const TABLE_MONTHLY_PROFILE_SHARE = "monthly_load_profile_share";
const TABLE_USAGE_HOVER = "usage_hover_intervals";
const MONTHLY_PROFILE_TOU_COLOR = "#c9933a";
const WHEEL_ZOOM_SENSITIVITY = 0.0009;
const ZOOM_HANDOFF_MS = 31 * 24 * 60 * 60 * 1000;
const USAGE_MARGIN_LEFT = 44;
const SUMMARY_MARGIN_LEFT = 54;
const USAGE_MARGIN_TOP = 32;
const SUMMARY_MARGIN_TOP = 38;
const HOVER_LABEL_ESTIMATED_WIDTH = 260;
const HOVER_LABEL_INSIDE_ESTIMATED_WIDTH = 190;
const SERIES_COLORS = {
  standard: "#4e79a7",
  tou: "#c9933a",
  offPeak: "#4e79a7",
  onPeak: "#c9933a"
};
const MISSING_DAYS_THRESHOLD = 4;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

type RenderGuard = () => boolean;

function alwaysCurrent(): boolean {
  // Default for standalone chart calls; dashboard redraws pass a guard that rejects stale async renders after data reloads.
  return true;
}

function scopedTableName(base: string, scope: string): string {
  return scope ? `${base}_${scope.replace(/[^A-Za-z0-9_]/g, "_")}` : base;
}

function asMillis(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(new Date(String(value)));
}

function toDates(domain: number[]): Date[] {
  return domain.map(value => new Date(value));
}

function asDomain(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lo = asMillis(value[0]);
  const hi = asMillis(value[1]);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
}

function clampDomain(domain: number[], bounds: number[]): number[] {
  const width = domain[1] - domain[0];
  const boundsWidth = bounds[1] - bounds[0];
  if (width >= boundsWidth) return bounds;
  const lo = Math.max(bounds[0], Math.min(domain[0], bounds[1] - width));
  return [lo, lo + width];
}

function translateDomain(domain: number[], delta: number): number[] {
  return [domain[0] + delta, domain[1] + delta];
}

function intersectDomains(left: number[], right: number[]): number[] {
  const lo = Math.max(left[0], right[0]);
  const hi = Math.min(left[1], right[1]);
  return hi > lo ? [lo, hi] : left;
}

function containsDomain(container: number[], candidate: number[]): boolean {
  const tolerance = 60 * 1000;
  return candidate[0] >= container[0] - tolerance && candidate[1] <= container[1] + tolerance;
}

function setPlotDomain(plotElement: HTMLElement, domain: number[]): void {
  const plot = (plotElement as HTMLInputElement).value as unknown as {
    setAttribute?: (name: string, value: unknown) => boolean;
    update?: () => void;
  };
  if (plot?.setAttribute?.("xDomain", toDates(domain))) plot.update?.();
}

function plotXRange(plotElement: HTMLElement): number[] {
  const plot = (plotElement as HTMLInputElement).value as unknown as {
    getAttribute: (name: string) => number;
  };
  return [plot.getAttribute("marginLeft"), plot.getAttribute("width") - plot.getAttribute("marginRight")];
}

function eventSvgPoint(event: MouseEvent, plotElement: HTMLElement): { x: number; y: number } | null {
  const svg = plotElement.querySelector("svg");
  const rect = svg?.getBoundingClientRect();
  const plot = (plotElement as HTMLInputElement).value as unknown as {
    getAttribute: (name: string) => number;
  };
  if (!rect || !plot) return null;
  return {
    x: ((event.clientX - rect.left) / rect.width) * plot.getAttribute("width"),
    y: ((event.clientY - rect.top) / rect.height) * plot.getAttribute("height")
  };
}

function isInsidePlotArea(plotElement: HTMLElement, event: WheelEvent | PointerEvent): boolean {
  const point = eventSvgPoint(event, plotElement);
  const plot = (plotElement as HTMLInputElement).value as unknown as {
    getAttribute: (name: string) => number;
  };
  if (!point || !plot) return false;
  const x0 = plot.getAttribute("marginLeft");
  const x1 = plot.getAttribute("width") - plot.getAttribute("marginRight");
  const y0 = plot.getAttribute("marginTop");
  const y1 = plot.getAttribute("height") - plot.getAttribute("marginBottom");
  return point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1;
}

function invertPlotX(plotElement: HTMLElement, pointX: number, domain: number[]): number {
  const [x0, x1] = plotXRange(plotElement);
  const ratio = (pointX - x0) / (x1 - x0);
  return domain[0] + ratio * (domain[1] - domain[0]);
}

function source(table: string, filterBy?: unknown) {
  return vg.from(table, { filterBy, optimize: false });
}

function commonOptions(width: number, height: number) {
  return [
    vg.style("background: var(--bg); color: var(--text); font-family: var(--font-sans);"),
    vg.width(width),
    vg.height(height),
    vg.marginLeft(USAGE_MARGIN_LEFT),
    vg.marginRight(16),
    vg.marginTop(USAGE_MARGIN_TOP),
    vg.marginBottom(28),
    vg.xTickRotate(0),
    vg.xLabel(null),
    vg.yLabel("kWh"),
    vg.yLabelArrow(true),
    vg.yTickSize(0),
    vg.yGrid(true)
  ];
}

function chartWidth(container: HTMLElement): number {
  return Math.max(420, Math.floor(container.getBoundingClientRect().width || 760));
}

interface LinkedState {
  overviewRange: ReturnType<typeof vg.Selection.single>;
  detailRange: ReturnType<typeof vg.Selection.single>;
  hoverLabelCutoff?: vg.Param<Date>;
  hoverInsideIntervalMs?: vg.Param<number>;
  labelFlipShare?: number;
  labelInsideShare?: number;
  fullDomain: number[];
  top: HTMLElement;
  middle: HTMLElement;
  bottom: HTMLElement;
}

function attachLinkedInteractions(state: LinkedState): void {
  const syncDomains = () => {
    const overview = asDomain(state.overviewRange.value) || state.fullDomain;
    const detail = asDomain(state.detailRange.value);
    if (detail && !containsDomain(overview, detail)) {
      state.detailRange.reset();
      return;
    }
    setPlotDomain(state.bottom, state.fullDomain);
    setPlotDomain(state.middle, overview);
    const topDomain = detail ? intersectDomains(overview, detail) : overview;
    setPlotDomain(state.top, topDomain);
    if (state.hoverLabelCutoff && state.labelFlipShare != null) {
      const cutoff = topDomain[1] - (topDomain[1] - topDomain[0]) * state.labelFlipShare;
      state.hoverLabelCutoff.update(new Date(cutoff));
    }
    if (state.hoverInsideIntervalMs && state.labelInsideShare != null) {
      state.hoverInsideIntervalMs.update((topDomain[1] - topDomain[0]) * state.labelInsideShare);
    }
  };

  state.overviewRange.addEventListener("value", syncDomains);
  state.detailRange.addEventListener("value", syncDomains);

  let pan:
    | {
        pointerId: number;
        startTime: number;
        overview: number[];
        overviewSelection: number[] | null;
        detail: number[] | null;
      }
    | null = null;

  state.top.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    if (!isInsidePlotArea(state.top, event)) return;
    const point = eventSvgPoint(event, state.top);
    if (!point) return;
    const overviewSelection = asDomain(state.overviewRange.value);
    const overview = overviewSelection || state.fullDomain;
    const detail = asDomain(state.detailRange.value);
    const topDomain = detail ? intersectDomains(overview, detail) : overview;
    if (!detail && !overviewSelection) return;
    pan = {
      pointerId: event.pointerId,
      startTime: invertPlotX(state.top, point.x, topDomain),
      overview,
      overviewSelection,
      detail
    };
    state.top.classList.add("is-panning");
    state.top.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  state.top.addEventListener("pointermove", event => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    const point = eventSvgPoint(event, state.top);
    if (!point) return;
    const baseDomain = pan.detail ? intersectDomains(pan.overview, pan.detail) : pan.overview;
    const delta = pan.startTime - invertPlotX(state.top, point.x, baseDomain);
    const overviewInteractor = ((state.bottom as HTMLInputElement).value as any).interactors[0];
    const detailInteractor = ((state.middle as HTMLInputElement).value as any).interactors[0];

    if (pan.detail) {
      const nextDetail = clampDomain(translateDomain(pan.detail, delta), state.fullDomain);
      publishDataInterval(detailInteractor, nextDetail);
    } else if (pan.overviewSelection) {
      publishDataInterval(overviewInteractor, clampDomain(translateDomain(pan.overview, delta), state.fullDomain));
    }
    event.preventDefault();
  });

  state.top.addEventListener("pointerup", event => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    pan = null;
    state.top.classList.remove("is-panning");
    state.top.releasePointerCapture(event.pointerId);
  });

  for (const [plot, interactor] of [
    [state.bottom, (_event: WheelEvent) => ((state.bottom as HTMLInputElement).value as any).interactors[0]],
    [state.middle, (_event: WheelEvent) => ((state.middle as HTMLInputElement).value as any).interactors[0]],
    [
      state.top,
      (event: WheelEvent) => {
        const direction = Math.sign(event.deltaY);
        const detail = asDomain(state.detailRange.value);
        const overview = asDomain(state.overviewRange.value) || state.fullDomain;
        if (detail) {
          const detailWidth = detail[1] - detail[0];
          const overviewWidth = overview[1] - overview[0];
          if (direction > 0 && detailWidth >= overviewWidth * 0.96) {
            state.detailRange.reset();
            return ((state.bottom as HTMLInputElement).value as any).interactors[0];
          }
          return ((state.middle as HTMLInputElement).value as any).interactors[0];
        }
        const overviewSelection = asDomain(state.overviewRange.value);
        if (direction < 0 && overviewSelection && overviewSelection[1] - overviewSelection[0] <= ZOOM_HANDOFF_MS) {
          return ((state.middle as HTMLInputElement).value as any).interactors[0];
        }
        return ((state.bottom as HTMLInputElement).value as any).interactors[0];
      }
    ]
  ] as const) {
    plot.addEventListener(
      "wheel",
      event => {
        if (!isInsidePlotArea(plot, event)) return;
        const handled = zoomInterval(interactor(event), event);
        if (plot === state.top && Math.sign(event.deltaY) > 0) {
          const overview = asDomain(state.overviewRange.value) || state.fullDomain;
          const detail = asDomain(state.detailRange.value);
          if (detail && detail[1] - detail[0] >= (overview[1] - overview[0]) * 0.96) {
            state.detailRange.reset();
          }
        }
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      { passive: false }
    );
  }

  syncDomains();
}

function zoomInterval(interactor: any, event: WheelEvent): boolean {
  const scale = interactor?.scale;
  if (!scale) return false;
  const direction = Math.sign(event.deltaY);
  if (!direction) return false;
  const range = scale.range.slice().sort((a: number, b: number) => a - b);
  const value = interactor.value;
  const dataInterval = Array.isArray(value) && value.length === 2 ? value : scale.domain;
  const pixelInterval = dataInterval
    .map((value: unknown) => scale.apply(new Date(String(value))))
    .sort((a: number, b: number) => a - b);
  const anchor = (pixelInterval[0] + pixelInterval[1]) / 2;
  const currentWidth = pixelInterval[1] - pixelInterval[0];
  const factor = Math.exp(direction * WHEEL_ZOOM_SENSITIVITY * Math.min(Math.abs(event.deltaY), 160));
  const maxWidth = range[1] - range[0];
  const nextWidth = Math.min(Math.max(currentWidth * factor, 2), maxWidth);
  publishPixelInterval(interactor, [anchor - nextWidth / 2, anchor + nextWidth / 2]);
  return true;
}

function publishPixelInterval(interactor: any, interval: number[]): void {
  const scale = interactor.scale;
  const pixelInterval = interval.slice().sort((a, b) => a - b);
  const dataInterval = pixelInterval
    .map(value => scale.invert(value))
    .sort((a, b) => asMillis(a) - asMillis(b));
  interactor.value = dataInterval;
  interactor.g.call(interactor.brush.moveSilent, pixelInterval);
  interactor.selection.update(interactor.clause(dataInterval));
}

function publishDataInterval(interactor: any, interval: number[]): void {
  const dataInterval = toDates(interval);
  const pixelInterval = dataInterval
    .map(value => interactor.scale.apply(value))
    .sort((a: number, b: number) => a - b);
  interactor.value = dataInterval;
  interactor.g.call(interactor.brush.moveSilent, pixelInterval);
  interactor.selection.update(interactor.clause(dataInterval));
}

function sqlTimeLabel(timestamp: string, options: { meridiem?: boolean } = {}): string {
  const hour = `hour(${timestamp})`;
  const minute = `minute(${timestamp})`;
  const meridiem = options.meridiem ?? true;
  return `
concat(
  CAST(CASE
    WHEN ${hour} = 0 THEN 12
    WHEN ${hour} > 12 THEN ${hour} - 12
    ELSE ${hour}
  END AS VARCHAR),
  CASE
    WHEN ${minute} = 0 THEN ''
    ELSE concat(':', lpad(CAST(${minute} AS VARCHAR), 2, '0'))
  END${meridiem ? "," : ""}
  ${meridiem ? "' '," : ""}
  ${meridiem ? `CASE WHEN ${hour} < 12 THEN 'AM' ELSE 'PM' END` : ""}
)`.trim();
}

function sqlSameMeridiem(start: string, end: string): string {
  return `
CASE
  WHEN hour(${start}) < 12 AND hour(${end}) < 12 THEN TRUE
  WHEN hour(${start}) >= 12 AND hour(${end}) >= 12 THEN TRUE
  ELSE FALSE
END`.trim();
}

function sqlDateTimeLabel(timestamp: string, options: { meridiem?: boolean } = {}): string {
  return `
concat(
  strftime(${timestamp}, '%b '),
  CAST(day(${timestamp}) AS VARCHAR),
  strftime(${timestamp}, ', %Y, '),
  ${sqlTimeLabel(timestamp, options)}
)`.trim();
}

function sqlIntervalLabel(start: string, end: string): string {
  return `
CASE
  WHEN CAST(${start} AS DATE) = CAST(${end} AS DATE)
    AND ${sqlSameMeridiem(start, end)}
    THEN concat(${sqlDateTimeLabel(start, { meridiem: false })}, ' to ', ${sqlTimeLabel(end)})
  WHEN CAST(${start} AS DATE) = CAST(${end} AS DATE)
    THEN concat(${sqlDateTimeLabel(start)}, ' to ', ${sqlTimeLabel(end)})
  ELSE concat(${sqlDateTimeLabel(start)}, ' to ', ${sqlDateTimeLabel(end)})
END`.trim();
}

export async function renderUsageChart(
  container: HTMLElement,
  usage: ImportResult,
  isCurrent: RenderGuard = alwaysCurrent,
  scope = ""
): Promise<void> {
  if (!isCurrent()) return;
  container.replaceChildren();
  if (!(usage.usageSummary?.intervalCount ?? usage.rows.length)) return;
  await ensureUsageTable(usage);
  if (!isCurrent()) return;
  const usageTable = scopedTableName(TABLE_USAGE, scope);
  if (usageTable !== TABLE_USAGE) {
    await execSql(`CREATE OR REPLACE TABLE ${usageTable} AS SELECT * FROM ${TABLE_USAGE}`);
    if (!isCurrent()) return;
  }
  const [extent] = await queryJson<{ lo: string; hi: string }>(
    `SELECT min(timestamp_local) AS lo, max(timestamp_end_local) AS hi FROM ${usageTable}`
  );
  if (!isCurrent()) return;
  const width = chartWidth(container);
  const plotWidth = Math.max(1, width - USAGE_MARGIN_LEFT - 16);
  const labelFlipShare = HOVER_LABEL_ESTIMATED_WIDTH / plotWidth;
  const labelInsideShare = HOVER_LABEL_INSIDE_ESTIMATED_WIDTH / plotWidth;
  const hoverTable = scopedTableName(TABLE_USAGE_HOVER, scope);
  await execSql(`
CREATE OR REPLACE VIEW ${hoverTable} AS
SELECT
  usage.*,
  date_diff('millisecond', timestamp_local, timestamp_end_local) AS hover_interval_ms,
  epoch_ms(CAST((epoch_ms(timestamp_local) + epoch_ms(timestamp_end_local)) / 2 AS BIGINT)) AS hover_mid_local,
  concat(
    ${sqlIntervalLabel("timestamp_local", "timestamp_end_local")},
    '\n',
    CAST(round(usage_kwh, 2) AS VARCHAR),
    ' kWh'
  ) AS hover_title
FROM ${usageTable} AS usage
ORDER BY timestamp_local, read_time_occurrence, interval_index
`.trim());
  if (!isCurrent()) return;
  const fullDomain = [asMillis(extent.lo), asMillis(extent.hi)];
  const overviewRange = vg.Selection.single();
  const detailRange = vg.Selection.single();
  const focusRange = vg.Selection.intersect({ include: [overviewRange, detailRange] });
  const hoverPoint = vg.Selection.single({ empty: true });
  const hoverLabelCutoff = vg.Param.value(new Date(fullDomain[1]));
  const hoverInsideIntervalMs = vg.Param.value((fullDomain[1] - fullDomain[0]) * labelInsideShare);

  const top = vg.plot(
    vg.areaY(source(hoverTable, focusRange), {
      x: "timestamp_local",
      y: "usage_kwh",
      curve: "step-after",
      fill: "var(--chart-line)",
      fillOpacity: 0.62,
      stroke: "var(--chart-line)",
      strokeWidth: 1
    }),
    vg.rectX(source(hoverTable, hoverPoint), {
      x1: "timestamp_local",
      x2: "timestamp_end_local",
      fill: "rgba(201, 147, 58, 0.16)",
      stroke: "rgba(201, 147, 58, 0.7)",
      strokeWidth: 1
    }),
    vg.text(source(hoverTable, hoverPoint), {
      x: "timestamp_local",
      text: "hover_title",
      filter: vg.gte("hover_interval_ms", hoverInsideIntervalMs),
      dx: 8,
      dy: 7,
      frameAnchor: "top-left",
      textAnchor: "start",
      lineAnchor: "top",
      lineHeight: 1.28,
      fontSize: 12,
      fill: "var(--text)",
      stroke: "var(--bg)",
      strokeWidth: 4,
      paintOrder: "stroke",
      pointerEvents: "none"
    }),
    vg.text(source(hoverTable, hoverPoint), {
      x: "timestamp_end_local",
      text: "hover_title",
      filter: vg.and(
        vg.lt("hover_interval_ms", hoverInsideIntervalMs),
        vg.lte("timestamp_end_local", hoverLabelCutoff)
      ),
      dx: 8,
      dy: 7,
      frameAnchor: "top-left",
      textAnchor: "start",
      lineAnchor: "top",
      lineHeight: 1.28,
      fontSize: 12,
      fill: "var(--text)",
      stroke: "var(--bg)",
      strokeWidth: 4,
      paintOrder: "stroke",
      pointerEvents: "none"
    }),
    vg.text(source(hoverTable, hoverPoint), {
      x: "timestamp_local",
      text: "hover_title",
      filter: vg.and(
        vg.lt("hover_interval_ms", hoverInsideIntervalMs),
        vg.gt("timestamp_end_local", hoverLabelCutoff)
      ),
      dx: -8,
      dy: 7,
      frameAnchor: "top-right",
      textAnchor: "end",
      lineAnchor: "top",
      lineHeight: 1.28,
      fontSize: 12,
      fill: "var(--text)",
      stroke: "var(--bg)",
      strokeWidth: 4,
      paintOrder: "stroke",
      pointerEvents: "none"
    }),
    vg.dot(source(hoverTable, focusRange), {
      x: "hover_mid_local",
      y: "usage_kwh",
      r: 4,
      fillOpacity: 0,
      strokeOpacity: 0
    }),
    vg.nearestX({ as: hoverPoint, maxRadius: 10000 }),
    ...commonOptions(width, 330)
  ) as HTMLElement;
  const middle = vg.plot(
    vg.areaY(source(usageTable, overviewRange), {
      x: "timestamp_local",
      y: "usage_kwh",
      curve: "step-after",
      fill: "var(--chart-line)",
      fillOpacity: 0.5
    }),
    vg.intervalX({
      as: detailRange,
      field: "timestamp_local",
      brush: { fill: "rgba(80, 125, 210, 0.22)", stroke: "rgba(80, 125, 210, 0.9)" }
    }),
    ...commonOptions(width, 120)
  ) as HTMLElement;
  const bottom = vg.plot(
    vg.areaY(source(usageTable), {
      x: "timestamp_local",
      y: "usage_kwh",
      curve: "step-after",
      fill: "var(--chart-line)",
      fillOpacity: 0.46
    }),
    vg.intervalX({
      as: overviewRange,
      field: "timestamp_local",
      brush: { fill: "rgba(80, 125, 210, 0.18)", stroke: "rgba(80, 125, 210, 0.9)" }
    }),
    ...commonOptions(width, 110)
  ) as HTMLElement;

  if (!isCurrent()) return;
  container.replaceChildren(top, middle, bottom);
  attachLinkedInteractions({
    overviewRange,
    detailRange,
    hoverLabelCutoff,
    hoverInsideIntervalMs,
    labelFlipShare,
    labelInsideShare,
    fullDomain,
    top,
    middle,
    bottom
  });
}

function monthTickFormat(value: unknown, index: number): string {
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})$/);
  if (!match) return text;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  return index === 0 || match[2] === "01" ? `${month}\n${match[1]}` : month;
}

function yearTickFormat(value: unknown): string {
  return String(value).replace(/[^\d]/g, "");
}

function monthTooltipFormat(month: string): string {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return month;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  return `${monthName} ${match[1]}`;
}

function energyTooltip(period: string, kwh: number, date: string): string {
  return [
    `Period: ${period}`,
    `Energy: ${formatNumber(kwh, kwh >= 100 ? 0 : 1)} kWh`,
    `Date: ${date}`
  ].join("\n");
}

function dollarTickFormat(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `$${formatNumber(numeric)}` : String(value);
}

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const scale = 10 ** exponent;
  const normalized = value / scale;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * scale;
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

function ensureHatchPattern(
  svg: SVGSVGElement,
  stroke: string,
  direction: "forward" | "back" = "forward",
  id = `missing-month-hatch-${Math.random().toString(36).slice(2)}`
): string {
  if (svg.querySelector(`pattern[id="${id}"]`)) return id;
  const defs = svgElement("defs");
  defs.dataset.overlay = "tou-analyzer";
  const pattern = svgElement("pattern");
  pattern.setAttribute("id", id);
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("width", "8");
  pattern.setAttribute("height", "8");
  const line = svgElement("line");
  line.setAttribute("x1", "0");
  line.setAttribute("y1", direction === "forward" ? "8" : "0");
  line.setAttribute("x2", "8");
  line.setAttribute("y2", direction === "forward" ? "0" : "8");
  line.setAttribute("stroke", stroke);
  line.setAttribute("stroke-width", direction === "forward" ? "1.1" : "1.35");
  pattern.append(line);
  defs.append(pattern);
  svg.prepend(defs);
  return id;
}

function clearPlotOverlays(svg: SVGSVGElement): void {
  svg.querySelectorAll('[data-overlay="tou-analyzer"]').forEach(node => node.remove());
}

function schedulePlotOverlay(plot: HTMLElement, callback: () => void): void {
  let attempts = 0;
  const decorate = () => {
    const svg = plot.querySelector("svg");
    if (svg) {
      clearPlotOverlays(svg);
      callback();
    }
    attempts += 1;
    if (attempts < 5) window.setTimeout(decorate, 120);
  };
  window.requestAnimationFrame(decorate);
}

interface PairedBillGroup {
  group: string;
  standard: number;
  tou: number;
  tickLabel: string;
  missingDays?: number;
}

function pairedGeometry(groupCount: number): { groupStep: number; pairSpan: number; pairGap: number; barWidth: number } {
  const groupStep = 1;
  const pairSpan = Math.max(0.52, Math.min(0.72, 0.78 - groupCount * 0.004));
  const pairGap = Math.max(0.012, pairSpan * 0.035);
  const barWidth = (pairSpan - pairGap) / 2;
  return { groupStep, pairSpan, pairGap, barWidth };
}

function pairedBillRows(groups: PairedBillGroup[]): Record<string, string | number>[] {
  const rows: Record<string, string | number>[] = [];
  const { groupStep, pairSpan, pairGap, barWidth } = pairedGeometry(groups.length);
  for (const [index, group] of groups.entries()) {
    const center = index * groupStep;
    for (const [schedule, value, offset] of [
      ["Standard", group.standard, -pairSpan / 2],
      ["TOU", group.tou, pairGap / 2]
    ] as const) {
      const x1 = center + offset;
      const x2 = x1 + barWidth;
      rows.push({
        group: group.group,
        schedule,
        x1,
        x2,
        total: value,
        title: `${group.tickLabel.replace("\n", " ")}\n${schedule}: ${dollarTickFormat(value)}`
      });
    }
  }
  return rows;
}

function pairedOverlayRows(
  groups: PairedBillGroup[],
  yMax: number
): {
  missingRows: Record<string, string | number>[];
  touHigherRows: Record<string, string | number>[];
} {
  const { groupStep, pairSpan } = pairedGeometry(groups.length);
  const missingRows: Record<string, string | number>[] = [];
  const touHigherRows: Record<string, string | number>[] = [];
  for (const [index, group] of groups.entries()) {
    const center = index * groupStep;
    const x1 = center - pairSpan / 2;
    const x2 = center + pairSpan / 2;
    if ((group.missingDays ?? 0) > MISSING_DAYS_THRESHOLD) {
      missingRows.push({
        x1,
        x2,
        yMax,
        title: `${group.tickLabel.replace("\n", " ")}\nMissing data`
      });
    }
    if (group.tou > group.standard) {
      touHigherRows.push({
        x1,
        x2,
        yMax,
        title: `${group.tickLabel.replace("\n", " ")}\nTOU higher`
      });
    }
  }
  return { missingRows, touHigherRows };
}

async function renderPairedBillChart(
  element: HTMLElement,
  tableName: string,
  groups: PairedBillGroup[],
  options: {
    height?: number;
    tickFormat?: (value: unknown, index: number) => string;
    markTouHigher?: boolean;
  } = {},
  isCurrent: RenderGuard = alwaysCurrent
): Promise<void> {
  if (!isCurrent()) return;
  element.replaceChildren();
  if (!groups.length) return;
  const rows = pairedBillRows(groups);
  await loadObjectsTable(tableName, rows, {
    types: {
      group: "VARCHAR",
      schedule: "VARCHAR",
      x1: "DOUBLE",
      x2: "DOUBLE",
      total: "DOUBLE",
      title: "VARCHAR"
    }
  });
  if (!isCurrent()) return;
  const width = chartWidth(element);
  const { groupStep } = pairedGeometry(groups.length);
  const centers = groups.map((_, index) => index * groupStep);
  const tickLabels = groups.map(group => group.tickLabel);
  const height = options.height ?? 320;
  const marginRight = 14;
  const yMax = niceMax(Math.max(...groups.flatMap(group => [group.standard, group.tou])) * 1.04);
  const domainStart = centers[0] - 0.6;
  const domainEnd = centers[centers.length - 1] + 0.6;
  const missingPatternId = `${tableName}-missing-hatch`;
  const touHigherPatternId = `${tableName}-tou-higher-hatch`;
  const { missingRows, touHigherRows } = pairedOverlayRows(groups, yMax);
  if (missingRows.length) {
    await loadObjectsTable(`${tableName}_missing`, missingRows, {
      types: { x1: "DOUBLE", x2: "DOUBLE", yMax: "DOUBLE", title: "VARCHAR" }
    });
    if (!isCurrent()) return;
  }
  if (options.markTouHigher && touHigherRows.length) {
    await loadObjectsTable(`${tableName}_tou_higher`, touHigherRows, {
      types: { x1: "DOUBLE", x2: "DOUBLE", yMax: "DOUBLE", title: "VARCHAR" }
    });
    if (!isCurrent()) return;
  }
  const marks: unknown[] = [];
  if (missingRows.length) {
    marks.push(
      vg.rectY(source(`${tableName}_missing`), {
        x1: "x1",
        x2: "x2",
        y1: 0,
        y2: "yMax",
        fill: `url(#${missingPatternId})`,
        fillOpacity: 0.5,
        title: "title"
      })
    );
  }
  if (options.markTouHigher && touHigherRows.length) {
    marks.push(
      vg.rectY(source(`${tableName}_tou_higher`), {
        x1: "x1",
        x2: "x2",
        y1: 0,
        y2: "yMax",
        fill: `url(#${touHigherPatternId})`,
        fillOpacity: 0.78,
        title: "title"
      })
    );
  }
  marks.push(
    vg.rectY(source(tableName), {
      x1: "x1",
      x2: "x2",
      y: "total",
      fill: "schedule",
      title: "title",
      tip: true
    })
  );
  const plot = vg.plot(
    ...marks,
    vg.width(width),
    vg.height(height),
    vg.style("background: var(--bg); color: var(--text); font-family: var(--font-sans);"),
    vg.marginLeft(SUMMARY_MARGIN_LEFT),
    vg.marginRight(marginRight),
    vg.marginTop(SUMMARY_MARGIN_TOP),
    vg.marginBottom(62),
    vg.xDomain([domainStart, domainEnd]),
    vg.xTicks(centers),
    vg.xTickFormat((value: unknown, index: number) => {
      const label = tickLabels[index];
      return label ?? (options.tickFormat ? options.tickFormat(value, index) : String(value));
    }),
    vg.xTickRotate(0),
    vg.xLabel(null),
    vg.yLabel("Bill [$]"),
    vg.yLabelArrow(true),
    vg.yTickSize(0),
    vg.yTickFormat(dollarTickFormat),
    vg.yDomain([0, yMax]),
    vg.colorDomain(["Standard", "TOU"]),
    vg.colorRange([SERIES_COLORS.standard, SERIES_COLORS.tou]),
    vg.yGrid(true)
  ) as HTMLElement;
  if (!isCurrent()) return;
  element.replaceChildren(plot);
  if (missingRows.length || (options.markTouHigher && touHigherRows.length)) {
    schedulePlotOverlay(plot, () => {
      const svg = plot.querySelector("svg");
      if (!svg) return;
      if (missingRows.length) ensureHatchPattern(svg, "var(--missing-hatch)", "forward", missingPatternId);
      if (options.markTouHigher && touHigherRows.length) {
        ensureHatchPattern(svg, "var(--tou-higher-hatch)", "back", touHigherPatternId);
      }
    });
  }
}

async function renderBarChart(
  element: HTMLElement,
  tableName: string,
  rows: Record<string, string | number>[],
  options: {
    x: string;
    y: string;
    fill: string;
    title: string;
    yLabel: string;
    height?: number;
    group?: string;
    groupTickRotate?: number;
    groupTickFormat?: (value: unknown, index: number) => string;
    colorDomain: string[];
    colorRange: string[];
    xDomain?: string[];
    xTickFormat?: (value: unknown, index: number) => string;
    xTickRotate?: number;
    yTickFormat?: (value: unknown) => string;
    missingIndices?: number[];
    touHigherIndices?: number[];
    xCount?: number;
    yMax?: number;
  },
  isCurrent: RenderGuard = alwaysCurrent
): Promise<void> {
  if (!isCurrent()) return;
  element.replaceChildren();
  if (!rows.length) return;
  const types: Record<string, string> = {
    [options.x]: "VARCHAR",
    [options.fill]: "VARCHAR"
  };
  if (options.group) types[options.group] = "VARCHAR";
  if ("title" in rows[0]) types.title = "VARCHAR";
  await loadObjectsTable(tableName, rows, { types });
  if (!isCurrent()) return;
  const width = chartWidth(element);
  const height = options.height ?? 320;
  const marginBottom = options.group ? 62 : 48;
  const channels: Record<string, unknown> = {
    x: options.x,
    y: options.y,
    fill: options.fill,
    insetLeft: 1,
    insetRight: 1,
    tip: true
  };
  if ("title" in rows[0]) channels.title = "title";
  if (options.group) channels.fx = options.group;
  const categories = Array.from(new Set(rows.map(row => String(row[options.x]))));
  const yMax = options.yMax ?? niceMax(Math.max(...rows.map(row => Number(row[options.y]) || 0)) * 1.04);
  const missingRows = (options.missingIndices ?? [])
    .map(index => categories[index])
    .filter((category): category is string => Boolean(category))
    .map(category => ({
      [options.x]: category,
      missing_y: yMax,
      title: `${monthTooltipFormat(category)}\nMissing data`
    }));
  const touHigherRows = (options.touHigherIndices ?? [])
    .map(index => categories[index])
    .filter((category): category is string => Boolean(category))
    .map(category => ({
      [options.x]: category,
      tou_higher_y: yMax,
      title: `${monthTooltipFormat(category)}\nTOU higher`
    }));
  const missingPatternId = `${tableName}-missing-hatch`;
  const touHigherPatternId = `${tableName}-tou-higher-hatch`;
  if (missingRows.length) {
    await loadObjectsTable(`${tableName}_missing`, missingRows, {
      types: {
        [options.x]: "VARCHAR",
        missing_y: "DOUBLE",
        title: "VARCHAR"
      }
    });
    if (!isCurrent()) return;
  }
  if (touHigherRows.length) {
    await loadObjectsTable(`${tableName}_tou_higher`, touHigherRows, {
      types: {
        [options.x]: "VARCHAR",
        tou_higher_y: "DOUBLE",
        title: "VARCHAR"
      }
    });
    if (!isCurrent()) return;
  }
  const marks: unknown[] = [];
  if (missingRows.length) {
    marks.push(
      vg.rectY(source(`${tableName}_missing`), {
        x: options.x,
        y1: 0,
        y2: "missing_y",
        fill: `url(#${missingPatternId})`,
        fillOpacity: 0.5,
        insetLeft: 0,
        insetRight: 0,
        title: "title"
      })
    );
  }
  marks.push(vg.barY(source(tableName), channels));
  if (touHigherRows.length) {
    marks.push(
      vg.rectY(source(`${tableName}_tou_higher`), {
        x: options.x,
        y1: 0,
        y2: "tou_higher_y",
        fill: `url(#${touHigherPatternId})`,
        fillOpacity: 0.78,
        insetLeft: 0,
        insetRight: 0,
        title: "title"
      })
    );
  }
  const plot = vg.plot(
    ...marks,
    vg.width(width),
    vg.height(height),
    vg.style("background: var(--bg); color: var(--text); font-family: var(--font-sans);"),
    vg.marginLeft(SUMMARY_MARGIN_LEFT),
    vg.marginRight(14),
    vg.marginTop(SUMMARY_MARGIN_TOP),
    vg.marginBottom(marginBottom),
    vg.xAxis(options.group ? null : true),
    vg.xScale("band"),
    vg.xTickRotate(options.xTickRotate ?? (options.group ? 0 : -35)),
    vg.xTickFormat(options.xTickFormat),
    vg.xLabel(null),
    vg.xDomain(options.xDomain),
    vg.fxLabel(null),
    vg.fxTickRotate(options.groupTickRotate ?? -30),
    vg.fxTickFormat(options.groupTickFormat),
    vg.fxTickSize(0),
    vg.fxTickPadding(8),
    vg.fxPaddingInner(0.2),
    vg.fxPaddingOuter(0.04),
    vg.yLabel(options.yLabel),
    vg.yLabelArrow(true),
    vg.yTickSize(0),
    vg.yTickFormat(options.yTickFormat),
    ...(options.yMax ? [vg.yDomain([0, options.yMax])] : []),
    vg.colorDomain(options.colorDomain),
    vg.colorRange(options.colorRange),
    vg.yGrid(true)
  ) as HTMLElement;
  if (!isCurrent()) return;
  element.replaceChildren(plot);
  if (missingRows.length || touHigherRows.length) {
    schedulePlotOverlay(plot, () => {
      const svg = plot.querySelector("svg");
      if (!svg) return;
      if (missingRows.length) ensureHatchPattern(svg, "var(--missing-hatch)", "forward", missingPatternId);
      if (touHigherRows.length) ensureHatchPattern(svg, "var(--tou-higher-hatch)", "back", touHigherPatternId);
    });
  }
}

function hourTickFormat(value: unknown): string {
  const hour = Number(value);
  if (hour === 0 || hour === 24) return "12a";
  if (hour === 6) return "6a";
  if (hour === 12) return "12p";
  if (hour === 18) return "6p";
  return "";
}

function monthFacetRows(columns: number, yMax: number): Record<string, string | number>[] {
  return MONTH_NAMES.map((monthName, index) => ({
    month_index: index + 1,
    month_name: monthName,
    facet_col: index % columns,
    facet_row: Math.floor(index / columns),
    label_x: 0,
    label_y: yMax,
    share_x: 20,
    empty_x: 12,
    empty_y: yMax / 2
  }));
}

async function renderMonthlyLoadProfiles(
  element: HTMLElement,
  comparison: RateComparison,
  usage: ImportResult,
  tableName: string,
  usageTable: string,
  isCurrent: RenderGuard = alwaysCurrent
): Promise<void> {
  if (!isCurrent()) return;
  element.replaceChildren();
  if (!(usage.usageSummary?.intervalCount ?? usage.rows.length)) return;
  await ensureUsageTable(usage);
  if (!isCurrent()) return;
  const width = chartWidth(element);
  const columns = width < 720 ? 2 : 4;
  const rowsPerChart = Math.ceil(12 / columns);
  const monthTable = `${tableName}_months`;
  const peakTable = `${tableName}_peak`;
  const emptyTable = `${tableName}_empty`;
  const shareTable = `${tableName}_share`;

  await execSql(`
CREATE OR REPLACE TABLE ${tableName} AS
SELECT
  month(CAST(timestamp_local AS TIMESTAMP)) AS month_index,
  ((month(CAST(timestamp_local AS TIMESTAMP)) - 1) % ${columns}) AS facet_col,
  floor((month(CAST(timestamp_local AS TIMESTAMP)) - 1) / ${columns}) AS facet_row,
  hour(CAST(timestamp_local AS TIMESTAMP)) AS hour,
  avg(usage_kwh) AS avg_kwh,
  concat(
    CASE
      WHEN hour(CAST(timestamp_local AS TIMESTAMP)) = 0 THEN '12 a.m.'
      WHEN hour(CAST(timestamp_local AS TIMESTAMP)) < 12 THEN concat(CAST(hour(CAST(timestamp_local AS TIMESTAMP)) AS VARCHAR), ' a.m.')
      WHEN hour(CAST(timestamp_local AS TIMESTAMP)) = 12 THEN '12 p.m.'
      ELSE concat(CAST(hour(CAST(timestamp_local AS TIMESTAMP)) - 12 AS VARCHAR), ' p.m.')
    END,
    '\nAverage: ',
    CAST(round(avg(usage_kwh), 2) AS VARCHAR),
    ' kWh'
  ) AS tooltip
FROM ${usageTable}
GROUP BY month_index, facet_col, facet_row, hour
ORDER BY month_index, hour
`.trim());
  if (!isCurrent()) return;

  const [maxRow] = await queryJson<{ yMax: number }>(
    `SELECT COALESCE(max(avg_kwh), 0) AS yMax FROM ${tableName}`
  );
  if (!isCurrent()) return;
  const yMax = niceMax(Number(maxRow?.yMax ?? 0) * 1.08);
  const monthRows = monthFacetRows(columns, yMax);
  const monthsWithData = new Set(
    (await queryJson<{ month_index: number }>(
      `SELECT DISTINCT month_index FROM ${tableName}`
    )).map(row => Number(row.month_index))
  );
  if (!isCurrent()) return;
  const peakRows = monthRows.map(row => ({
    ...row,
    start_hour: 18,
    end_hour: 22,
    y_max: yMax,
    title: `${row.month_name} 6-10 p.m. TOU window`
  }));
  const emptyRows = monthRows
    .filter(row => !monthsWithData.has(Number(row.month_index)))
    .map(row => ({ ...row, label: "No data" }));
  const monthlyShares = new Map<number, { totalKwh: number; onPeakKwh: number }>();
  for (const month of comparison.monthly) {
    const monthIndex = Number(month.month.slice(5, 7));
    if (month.totalKwh <= 0) continue;
    const existing = monthlyShares.get(monthIndex) ?? { totalKwh: 0, onPeakKwh: 0 };
    existing.totalKwh += month.totalKwh;
    existing.onPeakKwh += month.onPeakKwh;
    monthlyShares.set(monthIndex, existing);
  }
  const shareRows: Record<string, unknown>[] = Array.from(monthlyShares.entries())
    .flatMap(([monthIndex, share]) => {
      const base = monthRows[monthIndex - 1];
      if (!base || share.totalKwh <= 0) return [];
      return [{
        ...base,
        share: `${formatNumber((share.onPeakKwh / share.totalKwh) * 100, 1)}%`,
        title: `${base.month_name} on-peak share`
      }];
    });

  await Promise.all([
    loadObjectsTable(monthTable, monthRows),
    loadObjectsTable(peakTable, peakRows),
    loadObjectsTable(emptyTable, emptyRows.length ? emptyRows : [{ month_index: -1, facet_col: -1, facet_row: -1, empty_x: 12, empty_y: yMax / 2, label: "" }]),
    loadObjectsTable(shareTable, shareRows.length ? shareRows : [{ month_index: -1, facet_col: -1, facet_row: -1, share_x: 20, label_y: yMax, share: "", title: "" }])
  ]);
  if (!isCurrent()) return;

  const peakPatternId = `${tableName}-peak-hatch`;
  const plot = vg.plot(
    vg.rectY(source(peakTable), {
      x1: "start_hour",
      x2: "end_hour",
      y1: 0,
      y2: "y_max",
      fx: "facet_col",
      fy: "facet_row",
      fill: `url(#${peakPatternId})`,
      fillOpacity: 0.5,
      title: "title"
    }),
    vg.areaY(source(tableName), {
      x: "hour",
      y: "avg_kwh",
      fx: "facet_col",
      fy: "facet_row",
      fill: "var(--chart-line)",
      fillOpacity: 0.18,
      curve: "linear"
    }),
    vg.lineY(source(tableName), {
      x: "hour",
      y: "avg_kwh",
      fx: "facet_col",
      fy: "facet_row",
      stroke: "var(--chart-line)",
      strokeWidth: 1.35
    }),
    vg.dot(source(tableName), {
      x: "hour",
      y: "avg_kwh",
      fx: "facet_col",
      fy: "facet_row",
      r: 7,
      fill: "transparent",
      stroke: "transparent",
      title: "tooltip",
      tip: true
    }),
    vg.text(source(monthTable), {
      x: "label_x",
      y: "label_y",
      fx: "facet_col",
      fy: "facet_row",
      text: "month_name",
      textAnchor: "start",
      dy: -7,
      fill: "var(--heading)",
      fontWeight: 700,
      fontSize: 12
    }),
    vg.text(source(shareTable), {
      x: "share_x",
      y: "label_y",
      fx: "facet_col",
      fy: "facet_row",
      text: "share",
      textAnchor: "middle",
      dy: -7,
      fill: MONTHLY_PROFILE_TOU_COLOR,
      fontWeight: 650,
      fontSize: 10
    }),
    vg.text(source(emptyTable), {
      x: "empty_x",
      y: "empty_y",
      fx: "facet_col",
      fy: "facet_row",
      text: "label",
      textAnchor: "middle",
      fill: "var(--muted)",
      fontSize: 10
    }),
    vg.width(width),
    vg.height(rowsPerChart * 126),
    vg.style("background: var(--bg); color: var(--text); font-family: var(--font-sans);"),
    vg.marginLeft(32),
    vg.marginRight(10),
    vg.marginTop(18),
    vg.marginBottom(28),
    vg.xDomain([0, 24]),
    vg.xTicks([0, 6, 12, 18]),
    vg.xTickFormat(hourTickFormat),
    vg.xTickRotate(0),
    vg.xLabel(null),
    vg.yDomain([0, yMax]),
    vg.yTicks(3),
    vg.yLabel(null),
    vg.yTickSize(0),
    vg.yGrid(true),
    vg.fxDomain(Array.from({ length: columns }, (_, index) => index)),
    vg.fyDomain(Array.from({ length: rowsPerChart }, (_, index) => index)),
    vg.fxAxis(null),
    vg.fyAxis(null),
    vg.fxLabel(null),
    vg.fyLabel(null),
    vg.fxPaddingInner(0.08),
    vg.fyPaddingInner(0.22)
  ) as HTMLElement;

  if (!isCurrent()) return;
  element.replaceChildren(plot);
  schedulePlotOverlay(plot, () => {
    const svg = plot.querySelector("svg");
    if (!svg) return;
    ensureHatchPattern(svg, MONTHLY_PROFILE_TOU_COLOR, "forward", peakPatternId);
    colorMonthlyProfileShareLabels(svg);
  });
}

function colorMonthlyProfileShareLabels(svg: SVGSVGElement): void {
  for (const text of svg.querySelectorAll("text")) {
    const label = text.firstChild?.textContent?.trim();
    if (!label?.endsWith("%")) continue;
    text.setAttribute("fill", MONTHLY_PROFILE_TOU_COLOR);
    text.style.fill = MONTHLY_PROFILE_TOU_COLOR;
  }
}

export async function renderSummaryCharts(comparison: RateComparison, slots: {
  monthlyBills: HTMLElement;
  annualBills: HTMLElement;
  monthlyPeak: HTMLElement;
  annualPeak: HTMLElement;
  monthlyProfile: HTMLElement;
}, usage: ImportResult, scope = "", isCurrent: RenderGuard = alwaysCurrent): Promise<void> {
  if (!isCurrent()) return;
  const monthlyBillsTable = scopedTableName(TABLE_MONTHLY_BILLS, scope);
  const annualBillsTable = scopedTableName(TABLE_ANNUAL_BILLS, scope);
  const monthlyPeakTable = scopedTableName(TABLE_MONTHLY_PEAK, scope);
  const annualPeakTable = scopedTableName(TABLE_ANNUAL_PEAK, scope);
  const monthlyProfileTable = scopedTableName(TABLE_MONTHLY_PROFILE, scope);
  const usageTable = scopedTableName(TABLE_USAGE, scope);
  if (usageTable !== TABLE_USAGE) {
    await ensureUsageTable(usage);
    if (!isCurrent()) return;
    await execSql(`CREATE OR REPLACE TABLE ${usageTable} AS SELECT * FROM ${TABLE_USAGE}`);
    if (!isCurrent()) return;
  }
  const monthlyBillGroups = comparison.monthly.map((month, index) => ({
    group: month.month,
    standard: month.standard.total,
    tou: month.tou.total,
    tickLabel: monthTickFormat(month.month, index),
    missingDays: month.missingDays
  }));
  const annualBillGroups = comparison.annual.map(year => ({
    group: year.year,
    standard: year.standardTotal,
    tou: year.touTotal,
    tickLabel: yearTickFormat(year.year)
  }));
  const monthlyPeakRows = comparison.monthly.flatMap(month => [
    {
      month: month.month,
      period: "Off-peak",
      kwh: month.offPeakKwh,
      title: energyTooltip("Off-peak", month.offPeakKwh, monthTooltipFormat(month.month))
    },
    {
      month: month.month,
      period: "On-peak",
      kwh: month.onPeakKwh,
      title: energyTooltip("On-peak", month.onPeakKwh, monthTooltipFormat(month.month))
    }
  ]);
  const annualPeakRows = comparison.annual.flatMap(year => [
    {
      year: String(year.year),
      period: "Off-peak",
      kwh: year.offPeakKwh,
      title: energyTooltip("Off-peak", year.offPeakKwh, String(year.year))
    },
    {
      year: String(year.year),
      period: "On-peak",
      kwh: year.onPeakKwh,
      title: energyTooltip("On-peak", year.onPeakKwh, String(year.year))
    }
  ]);

  const missingMonthIndices = comparison.monthly
    .map((month, index) => (month.missingDays > MISSING_DAYS_THRESHOLD ? index : -1))
    .filter(index => index >= 0);
  const touHigherMonthIndices = comparison.monthly
    .map((month, index) => (month.touMinusStandard > 0 ? index : -1))
    .filter(index => index >= 0);
  const monthlyEnergyMax = niceMax(Math.max(...comparison.monthly.map(month => month.totalKwh)) * 1.04);
  await Promise.all([
    renderMonthlyLoadProfiles(slots.monthlyProfile, comparison, usage, monthlyProfileTable, usageTable, isCurrent),
    renderPairedBillChart(slots.monthlyBills, monthlyBillsTable, monthlyBillGroups, {
      markTouHigher: true
    }, isCurrent),
    renderPairedBillChart(slots.annualBills, annualBillsTable, annualBillGroups, {
      height: 270
    }, isCurrent),
    renderBarChart(slots.monthlyPeak, monthlyPeakTable, monthlyPeakRows, {
      x: "month",
      y: "kwh",
      fill: "period",
      title: "Monthly total energy",
      yLabel: "kWh",
      xTickFormat: monthTickFormat,
      xTickRotate: 0,
      missingIndices: missingMonthIndices,
      touHigherIndices: touHigherMonthIndices,
      xCount: comparison.monthly.length,
      yMax: monthlyEnergyMax,
      colorDomain: ["Off-peak", "On-peak"],
      colorRange: [SERIES_COLORS.offPeak, SERIES_COLORS.onPeak]
    }, isCurrent),
    renderBarChart(slots.annualPeak, annualPeakTable, annualPeakRows, {
      x: "year",
      y: "kwh",
      fill: "period",
      title: "Annual total energy",
      yLabel: "kWh",
      xTickFormat: yearTickFormat,
      xTickRotate: 0,
      height: 270,
      colorDomain: ["Off-peak", "On-peak"],
      colorRange: [SERIES_COLORS.offPeak, SERIES_COLORS.onPeak]
    }, isCurrent)
  ]);
}
