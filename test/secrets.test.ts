import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const scanner = path.resolve('scripts/check-secrets.mjs');
function scan(lines: string[], tracked = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-secret-test-'));
  roots.push(root);
  spawnSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'fixture.txt'), lines.join('\n'));
  if (tracked) spawnSync('git', ['add', 'fixture.txt'], { cwd: root });
  return spawnSync(process.execPath, [scanner], { cwd: root, encoding: 'utf8' });
}

const cases: [string, string][] = [
  ['github', ['ghp', '_', 'a'.repeat(36)].join('')],
  ['github', ['gho', '_', 'b'.repeat(36)].join('')],
  ['github', ['ghs', '_', 'c'.repeat(36)].join('')],
  ['github', ['github', '_pat_', 'd'.repeat(50)].join('')],
  ['api-key', ['sk', '-', 'a'.repeat(40)].join('')],
  ['api-key', ['sk', '-ant-', 'a'.repeat(40)].join('')],
  ['aws', ['AKIA', 'A'.repeat(16)].join('')],
  ['private-key', ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')],
  ['slack', ['xox', 'b-', 'a'.repeat(30)].join('')],
  ['bearer', ['Bearer', ' ', 'a'.repeat(20)].join('')],
  ['email', ['dummy', '@', 'private.invalid'].join('')],
  ['phone', ['090', '-', '1234', '-', '5678'].join('')],
  ['phone', ['+81', ' 90-', '1234-', '5678'].join('')],
  ['phone', ['090', '1234', '5678'].join('')],
  ['address', ['〒', '123', '-', '4567'].join('')],
  ['address', ['東京都', '架空市', '一丁目'].join('')],
  ['tailnet', ['dummy', '.test.', 'ts', '.net'].join('')],
  ['tailnet-ip', [100, 64, 1, 2].join('.')],
  ['tailnet-ip', [100, 127, 255, 254].join('.')],
];

test.each(cases)('Secret scanner detects %s without printing its value', (type, value) => {
  for (const tracked of [false, true]) {
    const result = scan(['safe heading', value], tracked);
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(`fixture.txt:2: ${type}`);
    expect(result.stdout + result.stderr).not.toContain(value);
  }
});

test('Secret scanner allows documented dummy domains, line exemptions, and addresses outside the tailnet range', () => {
  const email = ['dummy', '@', 'example.com'].join('');
  const noreply = ['dummy', '@', 'users.noreply.github.com'].join('');
  const result = scan(['native-package@13.0.3', email, email.replace('.com', '.org'), noreply, [100, 63, 1, 2].join('.'), [100, 128, 1, 2].join('.'), `${cases[0]?.[1]} // secret-scan:allow`]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
});
