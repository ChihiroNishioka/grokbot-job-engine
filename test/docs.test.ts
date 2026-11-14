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
  for (const term of ['既定は無効', 'member', 'オーナーの道具と権限で動', 'GENIE_GROUP_CHAT_IDS', '構造的に守']) expect(text, term).toContain(term);
});

test('JE-FP10 family policy, migration, approval, and Routine guardrails are documented', () => {
  const spec = readFileSync('docs/SPEC.md', 'utf8');
  for (const term of ['### 14.5', 'allowed_capabilities', 'used_capabilities', 'DENY', 'HOLD', 'policy_decision', 'OWNER_NOTIFY_CHAT_ID', 'v0〜v3', 'queued または claimed member', 'Routine が `allowed_capabilities` を構造的に守る']) expect(spec, term).toContain(term);
  expect(spec).toContain("status='queued'");
  expect(spec).toContain('status の CHECK は変更しない');
  const agents = readFileSync('AGENTS.md', 'utf8');
  for (const term of ['family-policy-spec.md', 'allowed_capabilities', 'claim と complete', '構造的に守る']) expect(agents, term).toContain(term);
  const worker = readFileSync('docs/worker.md', 'utf8');
  for (const term of ['allowed_capabilities', 'used_capabilities', 'lookup', 'booking', '決定的な関数', 'OWNER_NOTIFY_CHAT_ID']) expect(worker, term).toContain(term);
  const genie = readFileSync('docs/genie.md', 'utf8');
  for (const term of ['OWNER_NOTIFY_CHAT_ID', 'v4移行', '/approve', '/許可', 'claim を止めたまま', 'used_capabilities']) expect(genie, term).toContain(term);
  const status = readFileSync('docs/status.md', 'utf8');
  for (const term of ['v4移行', 'allowed_capabilities', 'Routine の実装はこのリポジトリ外']) expect(status, term).toContain(term);
  expect(readFileSync('.env.example', 'utf8')).toMatch(/^OWNER_NOTIFY_CHAT_ID=$/m);
  const green = readFileSync('docs/GREEN.md', 'utf8');
  for (let i = 1; i <= 10; i++) expect(green, `JE-FP${i}`).toContain(`JE-FP${i}`);
});

test('JE-SH13 through JE-SH15 are in an independent sender handle section', () => {
  const green = readFileSync('docs/GREEN.md', 'utf8');
  const familyPolicyStart = green.indexOf('## 家族ジョブの権限ポリシー');
  const senderHandleStart = green.indexOf('## 送信者ハンドルの取得と表示');
  expect(senderHandleStart).toBeGreaterThan(familyPolicyStart);

  const familyPolicy = green.slice(familyPolicyStart, senderHandleStart);
  for (let i = 13; i <= 15; i++) expect(familyPolicy, `JE-SH${i}`).not.toContain(`JE-SH${i}`);

  const senderHandleSection = green.slice(senderHandleStart);
  for (let i = 13; i <= 15; i++) expect(senderHandleSection, `JE-SH${i}`).toContain(`JE-SH${i}`);
});

test('review fixes keep the family group exception and shared reply visibility clear', () => {
  const spec = readFileSync('docs/SPEC.md', 'utf8');
  const spec13 = spec.slice(spec.indexOf('## 13.'), spec.indexOf('## 14.'));
  const spec11 = spec.slice(spec.indexOf('## 11.'), spec.indexOf('## 12.'));
  expect(spec11).toContain('14章で置き換え');
  for (const term of ['14章で置き換え', 'sender_handle?:string', '`GENIE_GROUP_CHAT_IDS` の値も含める', '14章の家族なら `member`']) expect(spec13, term).toContain(term);
  for (const term of ['sender_is_me', '14章のグループ設定がないか', 'sender_handle` がない']) expect(spec13, term).toContain(term);

  const readme = readFileSync('README.md', 'utf8');
  expect(readme).toContain('家族グループの扱いは14章が13章を改めます');
  expect(readme).toContain('家族グループの chat_id に置き換えます');
  expect(readme).not.toContain('仕様13章が優先');
  expect(readme).not.toContain('自分宛てトークの chat_id に置き換えます');

  const green = readFileSync('docs/GREEN.md', 'utf8');
  const g65 = green.slice(green.indexOf('| G65 |'), green.indexOf('| G66 |'));
  for (const term of ['GENIE_GROUP_CHAT_IDS', 'sender_handle', 'ignored', 'member として受け付ける']) expect(g65, term).toContain(term);

  for (const path of ['docs/SPEC.md', 'docs/genie.md', 'docs/worker.md']) {
    const text = readFileSync(path, 'utf8');
    for (const term of ['先頭 40 字', '完了・失敗', 'notify.body', '結果の要約', 'URL', 'グループのメンバー全員']) expect(text, `${path} requires ${term}`).toContain(term);
  }
});
