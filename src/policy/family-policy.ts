import { z } from 'zod';

export const automaticCapabilities = [
  'lookup',
  'family_calendar_read',
  'family_calendar_add',
  'family_notes_append',
  'notify_owner',
] as const;
export const approvalCapabilities = ['booking'] as const;
export const forbiddenCapabilities = [
  'owner_mail',
  'owner_line',
  'owner_personal_event_write',
  'purchase',
  'message_others',
  'dev_settings',
  'vault',
] as const;

export const capabilitySchema = z.enum([...automaticCapabilities, ...approvalCapabilities, ...forbiddenCapabilities]);
export const grantableCapabilitySchema = z.enum([...automaticCapabilities, ...approvalCapabilities]);
export const automaticCapabilitySchema = z.enum([...automaticCapabilities]);
export const policyDecisionSchema = z.enum(['allow', 'deny', 'hold', 'approved']);
export type Capability = z.infer<typeof capabilitySchema>;
export type AutomaticCapability = z.infer<typeof automaticCapabilitySchema>;
export type GrantableCapability = z.infer<typeof grantableCapabilitySchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export const claimablePolicySql = "((requester_id='self' AND policy_decision IS NULL) OR (requester_id='member' AND policy_decision IN ('allow','approved')))";

type DenialReason = 'denied_vault' | 'denied_owner_mail' | 'denied_owner_line' | 'denied_owner_personal_event_write' | 'denied_purchase' | 'denied_message_others' | 'denied_dev_settings';
export type FamilyAssessment =
  | { decision: 'allow'; capabilities: AutomaticCapability[]; reasonCode: 'allowed'; groupReply: string }
  | { decision: 'deny'; capabilities: []; reasonCode: DenialReason; groupReply: string }
  | { decision: 'hold'; capabilities: GrantableCapability[]; reasonCode: 'needs_review'; groupReply: string; ownerNotify: true };

const denialRules: { reasonCode: DenialReason; patterns: readonly RegExp[] }[] = [
  { reasonCode: 'denied_vault', patterns: [/(?:パスワード|password|パスコード|passcode|カード\s*(?:の\s*)?(?:情報|番号)|暗証番号|クレジットカード|クレカ|口座|住所|vault|ヴォルト)/i] },
  { reasonCode: 'denied_owner_mail', patterns: [/(?:メール|mail|email|inbox)/i] },
  { reasonCode: 'denied_owner_line', patterns: [/LINE|ライン/i] },
  { reasonCode: 'denied_owner_personal_event_write', patterns: [/(?:(?:ちひろ|チヒロ|千尋|chihiro|オーナー)[^。!?\r\n]*(?:予定|スケジュール)|個人(?:の)?(?:予定|スケジュール))[^。!?\r\n]*(?:消|削除|移(?:動|し|す|せ|さ)|変更|ずら)/i] },
  { reasonCode: 'denied_purchase', patterns: [/(?:買(?:う|って|えば|おう|い(?:ます|たい)|わ)|購入|注文|支払|払(?:う|って|えば|おう|い(?:ます|たい)|わ)|送金|ポチ(?:って|る|ろう)|決済|有料|課金)/] },
  { reasonCode: 'denied_message_others', patterns: [/(?:あの人|他の人|別の人|友達|相手).{0,16}(?:メッセージ|連絡|送)|(?:メール|メッセージ|\bDM\b).{0,16}(?:送|して|送信)/i] },
  { reasonCode: 'denied_dev_settings', patterns: [/github|mac\s*mini|\bPR\b|プルリク|(?:開発|インストール|デプロイ)|(?:環境|システム|アプリ|Mac).{0,12}設定|設定.{0,12}(?:変更|変えて|見直|セット)/i] },
];

const candidatePatterns: { capability: AutomaticCapability; pattern: RegExp }[] = [
  { capability: 'family_calendar_read', pattern: /ファミリーカレンダー.{0,24}(?:見|確認|読|表示|調べ)/ },
  { capability: 'family_calendar_add', pattern: /ファミリーカレンダー.{0,32}(?:足|追加|登録|入れ|書き込)/ },
  { capability: 'family_notes_append', pattern: /家族.{0,20}(?:メモ|リスト|ノート).{0,32}(?:足|追加|追記|書|入れ)/ },
  { capability: 'notify_owner', pattern: /(?:ちひろ|オーナー).{0,16}(?:知らせ|報告|通知|連絡|教え)/ },
  { capability: 'lookup', pattern: /(?:天気|ニュース|調べて|検索|情報を|とは|意味を|翻訳して)/ },
];

const lookupTerms = ['present', 'problem', 'April', 'admin'] as const;
const listedLookupTerm = `(?:${lookupTerms.join('|')})`;

const allowedClauseRules: { capability: AutomaticCapability; pattern: RegExp }[] = [
  { capability: 'lookup', pattern: /^(?:(?:今日|明日|明後日|今週|来週|週末)の)?(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{1,12}の)?(?:天気|ニュース)(?:は|を(?:調べて|検索して|教えて|確認して))(?:ください)?$/u },
  { capability: 'lookup', pattern: new RegExp(`^${listedLookupTerm}(?:の情報)?を(?:調べて|検索して)(?:ください)?$`, 'i') },
  { capability: 'lookup', pattern: new RegExp(`^${listedLookupTerm}(?:とは|の意味を教えて)(?:ください)?$`, 'i') },
  { capability: 'family_calendar_read', pattern: /^ファミリーカレンダーを(?:見て|確認して|読んで|表示して|調べて)(?:ください)?$/ },
  { capability: 'family_calendar_add', pattern: /^ファミリーカレンダーに(?:今日|明日|明後日|[月火水木金土日]曜(?:日)?|週末)(?:の(?:朝|午前|昼|午後|夕方|夜))?(?:の予定)?を(?:足して|追加して|登録して|入れて|書き込んで)(?:ください)?$/ },
  { capability: 'family_notes_append', pattern: /^家族(?:の)?(?:買い物リスト|メモ|リスト|ノート)に(?:牛乳|卵|パン|米|野菜|果物)(?:と(?:牛乳|卵|パン|米|野菜|果物))*を(?:足して|追加して|追記して|書いて|入れて)(?:ください)?$/ },
  { capability: 'notify_owner', pattern: /^(?:終わったら|あとで)?(?:ちひろ|チヒロ|千尋|chihiro|オーナー)に(?:知らせて|報告して|通知して|連絡して|教えて)(?:ください)?$/i },
];

const bookingPattern = /(?:予約|booking|チケットを取|席を取)/i;
const scheduleWritePattern = /(?:予定|スケジュール|カレンダー).{0,24}(?:足|追加|登録|入れ|書き込)/;
const scheduleMentionPattern = /(?:予定|スケジュール|カレンダー)/;
const holdReply = 'ちひろの確認が必要です。動かすのは許可のあとです。';
const denyReply = 'ごめんなさい。この依頼は実行できません。ちひろに直接お願いしてください。';

export function classifyFamilyRequest(requestText: string): FamilyAssessment {
  const text = requestText.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  const clauses = text.split(/[、,。.!?;\r\n]+/u).map(clause => clause.trim()).filter(clause => clause.length > 0);
  for (const rule of denialRules) {
    if (rule.patterns.every(pattern => pattern.test(text))) return { decision: 'deny', capabilities: [], reasonCode: rule.reasonCode, groupReply: denyReply };
  }

  const matched = candidatePatterns.filter(rule => rule.pattern.test(text)).map(rule => rule.capability);
  const capabilities = new Set<GrantableCapability>(matched);
  const booking = bookingPattern.test(text);
  if (booking) capabilities.add('booking');
  if (scheduleMentionPattern.test(text) && scheduleWritePattern.test(text) && !text.includes('ファミリーカレンダー')) capabilities.add('family_calendar_add');

  const recognizedClauses = clauses.map(clause => allowedClauseRules.find(rule => rule.pattern.test(clause)));
  const allowedCapabilities = [...new Set(recognizedClauses.flatMap(rule => rule === undefined ? [] : [rule.capability]))];
  const hasTask = allowedCapabilities.some(capability => capability !== 'notify_owner');
  if (hasTask && recognizedClauses.every(rule => rule !== undefined) && !booking) {
    return { decision: 'allow', capabilities: allowedCapabilities.sort((a, b) => automaticCapabilities.indexOf(a) - automaticCapabilities.indexOf(b)), reasonCode: 'allowed', groupReply: '依頼を受け付けました。' };
  }

  return {
    decision: 'hold',
    capabilities: [...capabilities].sort((a, b) => [...automaticCapabilities, ...approvalCapabilities].indexOf(a) - [...automaticCapabilities, ...approvalCapabilities].indexOf(b)),
    reasonCode: 'needs_review',
    groupReply: holdReply,
    ownerNotify: true,
  };
}

export function parseGrantableCapabilities(value: string | null): GrantableCapability[] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  return z.array(grantableCapabilitySchema).parse(parsed);
}

export function isCapabilitySubset(used: Capability[], allowed: GrantableCapability[] | null): boolean {
  const permitted = new Set<Capability>(allowed ?? []);
  return used.every(capability => permitted.has(capability));
}
