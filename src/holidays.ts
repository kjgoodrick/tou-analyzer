const FIXED_HOLIDAYS = [
  [1, 1],
  [7, 4],
  [7, 24],
  [12, 25]
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function keyFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string {
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const date = utcDate(year, month, day);
    if (date.getUTCMonth() !== month - 1) break;
    if (date.getUTCDay() === weekday) {
      count += 1;
      if (count === nth) return keyFromDate(date);
    }
  }
  throw new Error(`Could not find weekday ${weekday} #${nth} in ${year}-${month}`);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  for (let day = 31; day >= 1; day -= 1) {
    const date = utcDate(year, month, day);
    if (date.getUTCMonth() !== month - 1) continue;
    if (date.getUTCDay() === weekday) return keyFromDate(date);
  }
  throw new Error(`Could not find weekday ${weekday} in ${year}-${month}`);
}

function addFixedHoliday(set: Set<string>, year: number, month: number, day: number): void {
  const actual = utcDate(year, month, day);
  set.add(keyFromDate(actual));

  const weekday = actual.getUTCDay();
  if (weekday === 6) set.add(keyFromDate(addDays(actual, -1)));
  if (weekday === 0) set.add(keyFromDate(addDays(actual, 1)));
}

export function utahSchedule1Holidays(year: number): Set<string> {
  const holidays = new Set<string>();

  for (const holidayYear of [year - 1, year, year + 1]) {
    for (const [month, day] of FIXED_HOLIDAYS) {
      addFixedHoliday(holidays, holidayYear, month, day);
    }
  }

  holidays.add(nthWeekdayOfMonth(year, 2, 1, 3));
  holidays.add(lastWeekdayOfMonth(year, 5, 1));
  holidays.add(nthWeekdayOfMonth(year, 9, 1, 1));
  holidays.add(nthWeekdayOfMonth(year, 11, 4, 4));

  return new Set([...holidays].filter(key => key.startsWith(`${year}-`)));
}

export function isUtahSchedule1Holiday(dateIso: string): boolean {
  const year = Number(dateIso.slice(0, 4));
  if (!Number.isInteger(year)) return false;
  return utahSchedule1Holidays(year).has(dateIso);
}

export function isWeekday(dateIso: string): boolean {
  const [year, month, day] = dateIso.split("-").map(Number);
  const weekday = utcDate(year, month, day).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

export function isSchedule1TouOnPeak(timestampLocal: string): boolean {
  const normalized = timestampLocal.replace(" ", "T");
  const dateIso = normalized.slice(0, 10);
  const hour = Number(normalized.slice(11, 13));
  const minute = Number(normalized.slice(14, 16) || "0");
  const decimalHour = hour + minute / 60;

  return (
    decimalHour >= 18 &&
    decimalHour < 22 &&
    isWeekday(dateIso) &&
    !isUtahSchedule1Holiday(dateIso)
  );
}

export function monthFromTimestamp(timestampLocal: string): string {
  return timestampLocal.replace(" ", "T").slice(0, 7);
}

export function dateFromTimestamp(timestampLocal: string): string {
  return timestampLocal.replace(" ", "T").slice(0, 10);
}

export { dateKey };
