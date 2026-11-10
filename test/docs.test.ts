import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('fix2 docs Genie setup names the prerequisite PR and dedicated job settings', () => {
  for (const path of ['README.md', 'docs/genie.md']) {
    const text = readFileSync(path, 'utf8');
    for (const required of ['genie-in-messages', 'feat/job-engine-route', 'マージされるまでは', 'job_webhook_url: http://127.0.0.1:3321/ingress/genie', 'job_chat_ids: [<自分宛てトークの chat_id>]', 'reply_fetch_url: http://127.0.0.1:3321/genie/replies', 'job-secret', 'reply-secret', 'GENIE_TOKEN', '0600', 'Notion', 'webhook_url']) {
      expect(text, `${path} requires ${required}`).toContain(required);
    }
  }
});

test('fix2 docs verification status has one source and README starts with its introduction', () => {
  const status = existsSync('docs/status.md') ? readFileSync('docs/status.md', 'utf8') : '';
  for (const required of ['main.ts は Dispatcher を起動しません', '偽の spawn', 'EOF', '実際の tailscale nc は未実行', 'Genie との実配送は未実行', 'GitHub Actions', 'private', 'runner', 'box の通常シェル', '同じ手順']) expect(status).toContain(required);
  for (const path of ['README.md', 'docs/worker.md', 'docs/genie.md']) {
    const text = readFileSync(path, 'utf8');
    expect(text, path).toMatch(/\[[^\]]+\]\((?:docs\/)?status\.md\)/);
    expect(text, path).not.toContain('main.ts は Dispatcher を起動しません');
  }
  expect(readFileSync('README.md', 'utf8').split('\n\n')[1]).toContain('iMessage から受け付ける仕事');
});

test('fix2 docs GREEN test locations all point to existing test files', () => {
  const text = readFileSync('docs/GREEN.md', 'utf8');
  const locations = [...text.matchAll(/\btest\/[A-Za-z0-9/._-]+\.test\.ts\b/g)].map(match => match[0]);
  expect(locations.length).toBeGreaterThan(70);
  for (const path of new Set(locations)) expect(existsSync(path), path).toBe(true);
});

test('fix2 docs worker lists safe failure codes and explains message storage', () => {
  const text = readFileSync('docs/worker.md', 'utf8');
  for (const required of ['TIMEOUT', 'SOURCE_UNAVAILABLE', 'INVALID_REQUEST', 'PERMISSION_REQUIRED', 'PROCESSING_ERROR', '処理が時間切れになりました', '参照先を利用できません', '依頼の内容を確認してください', '処理に必要な権限がありません', 'error.message', '通知に出さず', '{ok:false, code', 'マスクして保存']) expect(text).toContain(required);
});
