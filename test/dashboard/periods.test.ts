import { expect, test } from 'vitest';
import { bucketContains, periodWindows } from '../../src/dashboard/periods.js';

const epoch = (value: string) => Date.parse(value);

test('D11 period starts use JST day, Monday week, and first-of-month boundaries', () => {
  const now = epoch('2026-11-14T12:34:56.000+09:00');
  expect(periodWindows('today', now).current.start).toBe(epoch('2026-11-14T00:00:00.000+09:00'));
  expect(periodWindows('week', now).current.start).toBe(epoch('2026-11-09T00:00:00.000+09:00'));
  expect(periodWindows('month', now).current.start).toBe(epoch('2026-11-01T00:00:00.000+09:00'));
  for (const period of ['today', 'week', 'month'] as const) expect(periodWindows(period, now).current.end).toBe(now);
});

test('D12 previous windows stop at the matching local time and clamp a missing month date', () => {
  const now = epoch('2026-11-14T12:34:56.000+09:00');
  expect(periodWindows('today', now).previous).toMatchObject({
    start: epoch('2026-11-13T00:00:00.000+09:00'), end: epoch('2026-11-13T12:34:56.000+09:00'),
  });
  expect(periodWindows('week', now).previous).toMatchObject({
    start: epoch('2026-11-02T00:00:00.000+09:00'), end: epoch('2026-11-07T12:34:56.000+09:00'),
  });
  expect(periodWindows('month', now).previous).toMatchObject({
    start: epoch('2026-10-01T00:00:00.000+09:00'), end: epoch('2026-10-14T12:34:56.000+09:00'),
  });
  const marchEnd = periodWindows('month', epoch('2026-03-31T23:45:00.000+09:00'));
  expect(marchEnd.previous.end).toBe(epoch('2026-02-28T23:45:00.000+09:00'));
});

test('D13 buckets are half-open except the current partial bucket, which includes now', () => {
  const now = epoch('2026-11-14T12:34:56.000+09:00');
  for (const period of ['today', 'week', 'month'] as const) {
    const window = periodWindows(period, now).current;
    expect(window.buckets.at(-1)?.end).toBe(now);
    expect(window.buckets.at(-1)?.includeEnd).toBe(true);
    expect(window.buckets.some(bucket => bucket.start > now)).toBe(false);
    const boundary = window.buckets[1]?.start;
    expect(boundary).toBeDefined();
    if (boundary !== undefined) {
      expect(window.buckets.some(bucket => bucket.start < boundary && bucketContains(bucket, boundary))).toBe(false);
      expect(window.buckets.some(bucket => bucket.start === boundary && bucketContains(bucket, boundary))).toBe(true);
    }
  }
});
