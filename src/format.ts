export function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits
  }).format(value);
}

export function formatKwh(value: number): string {
  return `${formatNumber(value, value >= 100 ? 0 : 1)} kWh`;
}

export function formatPercent(value: number, digits = 1): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: digits
  }).format(value);
}

export function monthName(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  const date = new Date(Date.UTC(year, monthNumber - 1, 1));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function formatDateRange(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${start} to ${end}`;
  }
  return `${formatDate(start)} to ${formatDate(end)} (${formatDuration(startDate, endDate)})`;
}

function formatDuration(startDate: Date, endDate: Date): string {
  const start = utcDateOnly(startDate);
  const end = utcDateOnly(endDate);
  if (end.getTime() < start.getTime()) return formatDuration(end, start);

  let years = end.getUTCFullYear() - start.getUTCFullYear();
  let cursor = addCalendar(start, years, 0);
  if (cursor.getTime() > end.getTime()) {
    years -= 1;
    cursor = addCalendar(start, years, 0);
  }

  let months =
    (end.getUTCFullYear() - cursor.getUTCFullYear()) * 12 + end.getUTCMonth() - cursor.getUTCMonth();
  let monthCursor = addCalendar(cursor, 0, months);
  if (monthCursor.getTime() > end.getTime()) {
    months -= 1;
    monthCursor = addCalendar(cursor, 0, months);
  }

  const days = Math.max(0, Math.round((end.getTime() - monthCursor.getTime()) / 86_400_000));
  const parts = [
    unitPart(years, "year"),
    unitPart(months, "month"),
    unitPart(days, "day")
  ].filter((part): part is string => Boolean(part));
  return parts.slice(0, 2).join(", ") || "1 day";
}

function utcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

function addCalendar(date: Date, years: number, months: number): Date {
  const next = new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth() + months, 1));
  const day = Math.min(date.getUTCDate(), daysInUtcMonth(next.getUTCFullYear(), next.getUTCMonth()));
  next.setUTCDate(day);
  return next;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function unitPart(value: number, unit: string): string | null {
  if (!value) return null;
  return `${formatNumber(value)} ${unit}${value === 1 ? "" : "s"}`;
}
