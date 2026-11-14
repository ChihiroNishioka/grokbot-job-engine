export type Period = 'today' | 'week' | 'month';
export interface Bucket {
  start: number;
  end: number;
  includeEnd: boolean;
  label: string;
}
export interface PeriodWindow {
  start: number;
  end: number;
  buckets: Bucket[];
}
export interface PeriodWindows {
  current: PeriodWindow;
  previous: PeriodWindow;
}

interface TokyoDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const tokyoFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function tokyoDate(epoch: number): TokyoDate {
  const parts = Object.fromEntries(tokyoFormatter.formatToParts(epoch).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    millisecond: new Date(epoch).getUTCMilliseconds(),
  };
}

function tokyoEpoch(date: TokyoDate): number {
  return Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute, date.second, date.millisecond) - 9 * hourMs;
}

function dateAt(date: TokyoDate, day: number): TokyoDate {
  return { ...date, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

function periodStart(period: Period, date: TokyoDate): number {
  if (period === 'today') return tokyoEpoch(dateAt(date, date.day));
  if (period === 'month') return tokyoEpoch(dateAt(date, 1));
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(Date.UTC(date.year, date.month - 1, date.day - daysSinceMonday));
  return tokyoEpoch({
    ...date,
    year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate(),
    hour: 0, minute: 0, second: 0, millisecond: 0,
  });
}

function previousMonthEnd(date: TokyoDate): number {
  const monthStart = new Date(Date.UTC(date.year, date.month - 2, 1));
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return tokyoEpoch({ ...date, year, month, day: Math.min(date.day, lastDay) });
}

function bucketLabel(period: Period, start: number): string {
  const date = tokyoDate(start);
  if (period === 'today') return `${String(date.hour).padStart(2, '0')}:00`;
  return `${String(date.month).padStart(2, '0')}/${String(date.day).padStart(2, '0')}`;
}

function buckets(period: Period, start: number, end: number): Bucket[] {
  const step = period === 'today' ? hourMs : dayMs;
  const firstDate = tokyoDate(start);
  let cursor = period === 'today'
    ? tokyoEpoch({ ...firstDate, minute: 0, second: 0, millisecond: 0 })
    : tokyoEpoch({ ...firstDate, hour: 0, minute: 0, second: 0, millisecond: 0 });
  const result: Bucket[] = [];
  while (cursor <= end) {
    const next = cursor + step;
    const bucketEnd = Math.min(next, end);
    result.push({ start: cursor, end: bucketEnd, includeEnd: bucketEnd === end, label: bucketLabel(period, cursor) });
    cursor = next;
  }
  return result;
}

export function periodWindows(period: Period, now: number): PeriodWindows {
  const localNow = tokyoDate(now);
  const currentStart = periodStart(period, localNow);
  let previousStart: number;
  let previousEnd: number;
  if (period === 'today') {
    previousStart = currentStart - dayMs;
    previousEnd = now - dayMs;
  } else if (period === 'week') {
    previousStart = currentStart - 7 * dayMs;
    previousEnd = now - 7 * dayMs;
  } else {
    const priorMonth = new Date(Date.UTC(localNow.year, localNow.month - 2, 1));
    previousStart = tokyoEpoch({
      ...localNow, year: priorMonth.getUTCFullYear(), month: priorMonth.getUTCMonth() + 1,
      day: 1, hour: 0, minute: 0, second: 0, millisecond: 0,
    });
    previousEnd = previousMonthEnd(localNow);
  }
  return {
    current: { start: currentStart, end: now, buckets: buckets(period, currentStart, now) },
    previous: { start: previousStart, end: previousEnd, buckets: buckets(period, previousStart, previousEnd) },
  };
}

export function bucketContains(bucket: Bucket, timestamp: number): boolean {
  return bucket.start <= timestamp && (timestamp < bucket.end || (bucket.includeEnd && timestamp === bucket.end));
}
