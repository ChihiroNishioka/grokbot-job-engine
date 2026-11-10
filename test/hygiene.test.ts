import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

test('G03 environment example has every key and source contains no real private endpoints or machine paths', () => {
  const text = fs.readFileSync('.env.example', 'utf8');
  const spec = fs.readFileSync('docs/SPEC.md', 'utf8');
  const section = spec.split('## 9.')[1]?.split('## 10.')[0] ?? '';
  const keys = new Set(section.match(/\b[A-Z][A-Z_]{2,}\b/g));
  for (const key of keys) expect(text, key).toMatch(new RegExp(`^${key}=.+$`, 'm'));
  expect(text).toContain('change-me-to-a-long-random-string-000000');
  for (const file of [...files('src'), ...files('test'), ...files('docs'), '.env.example']) {
    const content = fs.readFileSync(file, 'utf8');
    expect(content, file).not.toMatch(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i);
    expect(content, file).not.toMatch(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    for (const root of ['work' + 'space', 'ho' + 'me']) expect(content, file).not.toContain('/' + root + '/');
  }
});

test('G49 tests never open ports or wait using timers and CI exposes all quality gates', () => {
  for (const file of files('test').filter(file => file.endsWith('.ts'))) {
    const content = fs.readFileSync(file, 'utf8');
    expect(content, file).not.toMatch(/\.listen\s*\(|\bserve\s*\(|\bsetTimeout\s*\(/);
  }
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  for (const script of ['lint', 'typecheck', 'test', 'check:secrets']) expect(workflow).toContain(`npm ${script === 'test' ? 'test' : `run ${script}`}`);
});
