import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const rules = [
  ['github', /\b(?:gh[pso]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['api-key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ['aws', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['bearer', /\bBearer [A-Za-z0-9]{20,}/],
  ['phone', /(?:\b0\d0-\d{4}-\d{4}\b|\+81[ -]?\d[\d -]{7,}\d|(?<!\d)\d{10,11}(?!\d))/],
  ['address', /(?:〒\s*\d{3}-\d{4}|(?:東京都|北海道|(?:京都|大阪)府|[一-龥]{2,3}県)[^\s"'`<>]{1,40}[市区町村][^\s"'`<>]{0,40}(?:丁目|番地))/],
  ['tailnet', /\b(?:[a-z0-9-]+\.)+ts\.net\b/i],
];

function emailPresent(line) {
  const matches = line.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi) ?? [];
  return matches.some(value => !/^(?:example\.com|example\.org|users\.noreply\.github\.com)$/i.test(value.slice(value.lastIndexOf('@') + 1)));
}

function tailnetIpPresent(line) {
  return [...line.matchAll(/\b100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)].some(([, second, third, fourth]) => Number(second) >= 64 && Number(second) <= 127 && Number(third) <= 255 && Number(fourth) <= 255);
}

export function scanFiles(files) {
  const findings = [];
  for (const file of files) {
    if (file.split(/[\\/]/).includes('node_modules') || path.basename(file) === 'package-lock.json') continue;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.includes('secret-scan:allow')) continue;
      const kinds = rules.filter(([, regex]) => regex.test(line)).map(([type]) => type);
      if (emailPresent(line)) kinds.push('email');
      if (tailnetIpPresent(line)) kinds.push('tailnet-ip');
      for (const type of kinds) findings.push({ file, line: index + 1, type });
    }
  }
  return findings;
}

export function main() {
  try {
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error('git failed');
    const files = result.stdout.split('\0').filter(Boolean);
    const findings = scanFiles(files);
    for (const finding of findings) fs.writeSync(1, `${finding.file}:${finding.line}: ${finding.type}\n`);
    return findings.length > 0 ? 1 : 0;
  } catch {
    fs.writeSync(2, '秘密検査を実行できません\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
