import { expect, test } from 'vitest';
import { mask } from '../src/logging/mask.js';

test('G44 credential context masks values that resemble job IDs or timestamps', () => {
  expect(mask('Bearer J-000123')).toBe('[REDACTED]');
  expect(mask('password=J-000123')).toBe('password=[REDACTED]');
  expect(mask('secret=2026-11-11T00:00:00.000Z')).toBe('secret=[REDACTED]');
  expect(mask('J-000123 2026-11-11T00:00:00.000Z')).toBe('J-000123 2026-11-11T00:00:00.000Z');
});
