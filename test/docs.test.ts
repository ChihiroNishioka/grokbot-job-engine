import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('fix2 docs Genie setup names the prerequisite PR and dedicated job settings', () => {
  for (const path of ['README.md', 'docs/genie.md']) {
    const text = readFileSync(path, 'utf8');
    for (const required of ['genie-in-messages', 'feat/job-engine-route', 'マージされるまでは', '"job_webhook_url": "http://127.0.0.1:3321/ingress/genie"', '"job_chat_ids": [7]', '"reply_fetch_url": "http://127.0.0.1:3321/genie/replies"', 'GENIE_ALLOWED_CHAT_IDS', 'webhook_http_403', 'job-secret', 'reply-secret', 'GENIE_TOKEN', '0600', 'Notion', 'webhook_url']) {
      expect(text, `${path} requires ${required}`).toContain(required);
    }
  }
});

test('fix2 docs verification status has one source and README starts with its introduction', () => {
  const status = existsSync('docs/status.md') ? readFileSync('docs/status.md', 'utf8') : '';
  for (const required of ['main.ts は Dispatcher を起動しません', '偽の spawn', 'EOF', '実際の tailscale nc と IPv6 の実通信', 'Genie 経由の /status の実配送は実機で未確認', '実プロセスの stdin は box で確認済み', 'GitHub Actions', 'private', 'runner', 'box の通常シェル', '同じ手順']) expect(status).toContain(required);
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

test('JE-SH20 sender handle contract and deployment are documented', () => {
  const spec = readFileSync('docs/SPEC.md', 'utf8');
  for (const term of ['## 14.', 'GENIE_GROUP_CHAT_IDS', 'command_not_allowed', 'member', '^tel:', '^email:', '1,20', '1,64', '256', 'バックアップ', 'Job Engine を先に', 'ダウングレード']) expect(spec, term).toContain(term);
  const genie = readFileSync('docs/genie.md', 'utf8');
  for (const term of ['"sender_handle": "email:family@example.com"', 'GENIE_GROUP_CHAT_IDS', 'command_not_allowed', '400', '403', 'not_from_me']) expect(genie, term).toContain(term);
  expect(genie).not.toContain('受け付けるのは自分宛てのトークだけ');
  const worker = readFileSync('docs/worker.md', 'utf8');
  for (const term of ['sender_handle', '個人情報', '書き写さない', 'claim / get / complete / fail', 'requester_id', 'member', 'self']) expect(worker, term).toContain(term);
  expect(readFileSync('.env.example', 'utf8')).toMatch(/^GENIE_GROUP_CHAT_IDS=$/m);
  expect(readFileSync('docs/status.md', 'utf8')).toContain('送信者ハンドル');
  const green = readFileSync('docs/GREEN.md', 'utf8');
  for (let i = 1; i <= 22; i++) expect(green, `JE-SH${i}`).toContain(`JE-SH${i}`);
});

test.each(['docs/SPEC.md', 'docs/worker.md'])('JE-SH22/A1 member authority prerequisite and disabled default in %s', path => {
  const text = readFileSync(path, 'utf8');
  for (const term of ['既定は無効', 'member', 'オーナーの道具と権限で動く', 'GENIE_GROUP_CHAT_IDS', 'Routine 側で member に許す操作を決めること']) expect(text, term).toContain(term);
});
