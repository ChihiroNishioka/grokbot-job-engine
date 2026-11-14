# Job Engine オーナーダッシュボード初版

## 目的と範囲

この文書は、Job Engine を動かす Mac mini 上でオーナーが使う管理画面の初版仕様です。実装はこの文書と既存 Job Engine の契約に従います。

初版で、チヒロはブラウザーからジョブの概況、承認待ち、失敗、依頼者、ボット、個別ジョブの履歴を確認できます。画面からできる状態変更は、承認、却下、再実行だけです。

オーナー用 Hono アプリを既存プロセスに 1 つ追加します。既存の Job API と Genie Ingress は別アプリのままにし、ルートを共有しません。オーナーアプリは既定で `127.0.0.1` だけに待ち受けます。

この版の作業範囲は仕様と後続実装までです。マージ、本番デプロイ、Mac mini への導入は対象外です。

## 起動と設定

オーナーアプリは `startMain` に 3 つ目のリスナーとして追加します。Job Engine と同じプロセス、`DATABASE_PATH`、書き込み用 DB 接続、`JobStore` を使います。読み取りには同じ SQLite ファイルを開く専用 read-only 接続を使います。

| 環境変数 | 必須 | 既定値と制約 |
|---|---:|---|
| `DASHBOARD_TOKEN` | はい | 32 文字以上。`JOB_API_TOKEN` と `GENIE_TOKEN` のどちらとも異なる。未設定または違反時は起動しない |
| `DASHBOARD_HOST` | いいえ | `127.0.0.1`。`127.0.0.1`、`::1`、`localhost` のみ許可 |
| `DASHBOARD_PORT` | いいえ | `3322`。1〜65535 の整数。`PORT` と `GENIE_PORT` とは異なる |
| `DASHBOARD_ALIAS_KEY` | はい | 32 文字以上の専用ランダム値。実値は `.env` だけに置く |
| `DASHBOARD_ALIASES` | いいえ | 既定は空の JSON オブジェクト。HMAC 値から依頼者の表示名への対応表 |

`DASHBOARD_ALIASES` は JSON オブジェクトです。キーは保存済み `sender_handle` の UTF-8 バイト列に対する HMAC-SHA256 の小文字 64 桁の 16 進表記です。値は重複しない `家族[A-Z]+` 形式の表示名です。`本人` は設定できません。未登録のハンドルは `家族-` と HMAC の先頭 6 桁で表示します。ハンドルが NULL の member は `家族（識別なし）` と表示します。`requester_id=self` は常に `本人` です。設定不正時は値を出さず起動を拒否します。

未登録ハンドルの HMAC 先頭 6 桁が重複した場合は、一意になるまで表示用の接頭辞を延ばします。

`.env.example` に追加する値は、条件を満たすダミー値か空の対応表だけにします。実際のトークン、HMAC 鍵、別名設定は `.env` に置き、Git に追加しません。設定エラーと起動ログには設定値を出さず、環境変数名だけを出します。

実装では読み取り専用接続用の新しい関数 `openReadonlyDb(path)` を追加します。書き込み用の既存関数 `openDb` はマイグレーションを実行するため、読み取りには再利用しません。`openDb` で DB v4 から v5 へ移行した後、`openReadonlyDb` で同じ `DATABASE_PATH` を開きます。移行または読み取り専用接続の開始に失敗したら、オーナーアプリを起動しません。読み取り専用接続ではマイグレーションを呼ばず、書き込み PRAGMA や更新文を実行しません。読み取り接続は終了時に閉じます。

開発時は既存どおり `npm run dev` を実行します。ビルド済みの起動は既存どおり `npm run build` の後に `npm run start` を実行します。どちらも同じ設定を読み、Job API、Genie Ingress、オーナーアプリを起動します。ユニットテストは待ち受けず Hono の `app.request()` を使います。

## DB と書き込み境界

DB は v5 にします。v5 で追加できるテーブルは `operator_actions` だけです。既存テーブルの列や意味は変えません。移行は既存の DB マイグレーション経路で行い、再実行可能にします。v5 より新しい DB は既存方針どおり拒否します。

`operator_actions` はダッシュボード操作の監査と冪等性に使います。列は次のとおりです。

- `action_id TEXT PRIMARY KEY`。UUID。
- job_id TEXT NOT NULL。対象ジョブへの外部キー。
- `actor TEXT NOT NULL`。常に `dashboard:owner`。
- `action TEXT NOT NULL`。`approve`、`reject`、`retry`、`reveal_request`、`reveal_result` のいずれか。
- `expected_state TEXT`。操作時に期待した状態。reveal では NULL。
- `request_hash TEXT NOT NULL`。秘密や本文を含まない正規化済み要求のハッシュ。
- `outcome TEXT NOT NULL`。`applied`、`stale`、`rejected`、`revealed` のいずれか。
- `reason_code TEXT`。固定コード。値や本文を入れない。
- `result_state TEXT`。状態変更操作の安全な結果スナップショット。reveal では NULL。
- `at INTEGER NOT NULL`。UTC エポックミリ秒。

`expected_state` と `result_state` は、status、policy_decision、attempts、updated_at だけを含む JSON です。`request_hash` は job_id、action、expected、part をキー順固定の JSON にした SHA-256 です。使わない expected または part は JSON から省きます。

承認、却下、再実行の結果は、同じ `action_id` の再送時に状態変更を重ねないために保存します。同じ ID の再送は保存済み結果区分と最新の安全な状態を返します。reveal の同じ要求を再送した場合は、指定された側のテキストを read-only 接続から読み直し、同じマスク処理をして返します。監査行は増やしません。本文、結果、ハンドル、チャット ID、トークン、CSRF 値は保存しません。本文または結果を表示した記録には対象の種類だけを保存し、内容は保存しません。

ジョブ状態の変更は既存の書き込み接続上で既存 `JobStore` メソッドだけを呼びます。ダッシュボードから `jobs`、`job_runs`、`job_events` を直接更新しません。監査行の追加だけは `operator_actions` に書きます。新しい `JobStore` の状態変更メソッドは作りません。action_id 照合、期待状態確認、JobStore 呼び出し、監査行の保存は、同じ書き込みトランザクション内で直列化します。状態変更だけを別の更新文に置き換えません。

既存の `JobStore.approve`、`JobStore.cancel`、`JobStore.retry` の意味とシグネチャを変更してはいけません。`job_events` の actor も変えません。承認イベントの actor は `genie`、却下で呼ぶ cancel と再実行の actor は `api` のままです。ダッシュボードの actor と操作結果は `operator_actions` に記録します。

## 認証、セッション、CSRF

ログイン画面と認証済み画面の UI 文言は日本語にします。閲覧も操作もオーナーだけに許可します。家族向けの画面やロールは作りません。

ブラウザーはログインフォームから `DASHBOARD_TOKEN` を送ります。`JOB_API_TOKEN` や `GENIE_TOKEN` でログインできません。3 つの認証トークン値と `DASHBOARD_ALIAS_KEY` を HTML、JSON、Cookie、エラー、ログに出しません。Job API 用トークン、Genie 用トークン、別名 HMAC 鍵をブラウザーに渡しません。トークンを localStorage、sessionStorage、URL、HTML 埋め込み値に保存しません。

ログイン成功時は、ランダムなセッション ID を HttpOnly、SameSite=Strict、Path=/ の Cookie に設定します。セッションはサーバーのメモリに置き、12 時間で期限切れにします。プロセス再起動後は再ログインします。ローカル HTTP のため初版 Cookie に `Secure` 属性を要求しません。

ログイン後、ブラウザーは認証 Cookie を付けて `GET /api/session` を呼び、JSON の `csrfNonce` から CSRF nonce を取得します。CSRF nonce はセッションに結び付き、ログイン用認証トークンとは別の値です。ブラウザーは各認証済み POST の `X-CSRF-Token` ヘッダーに nonce を設定します。ログには出しません。すべての POST は JSON のみ受け付けます。POST は `Origin` が設定されたホストとポートに一致し、`Sec-Fetch-Site` が `same-origin` で、認証済み操作では CSRF nonce も正しい場合だけ受理します。1 つでも欠けるか一致しない場合は 403 で拒否します。

ログイン済みセッションは読み取りに 12 時間有効です。最後に `DASHBOARD_TOKEN` を確認してから 15 分を超えたセッションは書き込みできません。画面に再ログインを求め、正しいトークンで再認証した後に操作をやり直します。サーバーは再認証時刻を注入した時計で判定します。

未認証の HTML 要求には日本語ログイン画面を返します。未認証の JSON API 要求には 401 と固定エラーを返します。認証情報や受信した値をエラー文に含めません。

## 読み取りデータと個人情報

ブラウザーへ返すジョブ情報は、画面に必要な許可リストだけで組み立てます。`sender_handle`、`source_chat_id`、`source_message_id`、`payload_ref`、`claim_token`、完全な `error.message` は返しません。エラーは理由コードだけを返します。イベントの `detail` も返しません。`requester_id` は別名に置き換えます。

依頼者は `requester_id=self` を「本人」、member を設定済みまたは生成済みの別名で表示します。別名の HMAC はサーバー内だけで計算します。値が異なるハンドルは異なる別名になり、同じハンドルは再起動後も同じ別名になります。

依頼本文と結果は、初期 HTML、通常の JSON、一覧、詳細取得に含めません。「本文を表示」「結果を表示」を明示的に押した時だけ、要求した側のテキストを返します。既存の `mask()` と `redactHandle()` を通し、HTML として解釈せずテキストとして表示します。表示操作は CSRF 保護と 15 分以内の再認証を要し、`operator_actions` に対象種別と action_id を記録します。本文または結果の内容はログや監査行に残しません。

Job trace は `job_events` と `job_runs` の許可フィールドで構成します。時刻、イベント種別、actor、状態遷移、理由コード、run の attempt、worker_id、開始・終了、outcome、error_code を表示できます。イベント detail、run の秘密値、本文、結果、チャット情報は表示しません。

認証済み HTML と API には `Cache-Control: no-store` を付けます。CSP は同一生成元のスクリプト、スタイル、通信だけを許し、frame 表示を禁止します。外部 CDN、外部フォント、外部スクリプト、外部通信を使いません。フォントは OS 標準だけを使います。

## 期間集計と比較

すべての集計時刻は `Asia/Tokyo` の暦時刻で決め、境界を UTC エポックミリ秒に変換します。DB の `created_at` は UTC エポックミリ秒です。選択期間の合計は `periodStart <= created_at <= now` のジョブを数えます。時間または日単位の各バケットは `[bucketStart, bucketEnd)` です。`created_at` が境界と等しいジョブは、その境界から始まる後のバケットだけに入ります。現在の部分バケットは `[bucketStart, now]` とし、`created_at == now` のジョブも含めます。`now` より後のバケットは作りません。集計対象は `jobs.created_at` です。過去に作られたジョブも現在の状態で分類します。これは状態遷移履歴の再構築ではありません。

| 期間 | 現在の集計範囲 | バケット | 比較範囲 |
|---|---|---|---|
| 今日 | 今日 00:00 から現在まで | 1 時間 | 昨日 00:00 から昨日の同じ時刻まで |
| 今週 | 今週月曜 00:00 から現在まで | 1 日 | 先週月曜 00:00 から同じ曜日の同じ時刻まで |
| 今月 | 今月 1 日 00:00 から現在まで | 1 日 | 先月 1 日から同じ日付の同じ時刻まで |

各期間とバケットの境界は JST の暦時刻から UTC エポックミリ秒に変換します。比較期間の終端は、今日なら昨日の同じ時刻、今週なら先週の同じ曜日と時刻、今月なら先月の同じ日付と時刻です。先月に同じ日付がない場合は先月末日に切り詰めます。比較期間の終端は今日の 00:00 ではありません。比較期間の合計は比較開始からこの終端までを含みます。比較バケットも同じ半開区間の規則を使い、終端の部分バケットは終端まで含めます。現在時刻より後の時間や日付のバケットは作りません。比較線は対応する前期間バケットの総数です。先月に存在しない対応日の点は作りません。

今日、今週、今月のカードには各期間の合計、前期間との差件数、差の割合を表示します。割合は前期間が 0 件なら「比較対象なし」とし、ゼロ除算や推定値を出しません。前期間が 0 件でない場合は差の割合を整数パーセントに丸めます。両期間が 0 件なら差は「±0件」、割合は「比較対象なし」です。選択した期間のグラフには、現在のバケットを積み上げ、前期間の総数を細い線で重ねます。

概況には期間切替「今日」「今週」「今月」と、系列切替「状態」「依頼者」「ボット」を置きます。初期値は今日、状態です。選択した期間は概況、依頼者、ボットの各ビューで共通に使います。

状態系列の名前は `statusLabel` の返す状態名を使います。色は `statusLabel` の戻り値ではなく、下表で定義するダッシュボードの表示規則です。

完了は緑、承認待ちは黄、失敗は赤、お断りは橙、キャンセル済みと受付済みは灰、実行中は青で示します。各系列は色だけで判別させず、日本語名も併記します。

| 状態表示 | DB 条件 | 系列色 |
|---|---|---|
| 完了 | `status=done` | 完了色 |
| 承認待ち | `status=queued` かつ `policy_decision=hold` | 承認待ち色 |
| 失敗 | `status=failed` | 失敗色 |
| お断り | `status=cancelled` かつ `policy_decision=deny` | お断り色 |
| キャンセル済み | その他の `status=cancelled` | キャンセル色 |
| 実行中 | `status=claimed` | 実行中色 |
| 受付済み | `status=queued` かつ hold 以外 | 受付色 |

状態以外の系列では、同一の別名または worker_id に同じ色を保ちます。別名や worker が多い場合も凡例と件数を表示し、状態色と混同しない色を使います。グラフの色だけでなく日本語名も表示します。

依頼者系列は依頼者別名で分けます。ボット系列は各ジョブの最大 attempt の `job_runs.worker_id` で分けます。run がないジョブは「未着手」です。ボットの詳細ビューでは最後の run を持つジョブ数に加え、選択期間の run 数と成功・失敗数を表示できます。worker_id は表示用の識別子として扱い、他のハンドル情報と混ぜません。

グラフの棒またはバケットを選ぶと、その期間のジョブ一覧を表示します。承認待ちと失敗の一覧へ移動できます。依頼者ビューとボットビューも同じ期間とバケット規則を使い、選んだ別名または worker_id でジョブ一覧を絞ります。

現在の DB にはトークン数と費用の列がありません。トークン欄は選択期間にかかわらず `未記録` と表示します。0、推定値、費用を作らず、トークンの棒や線も描きません。

## 画面と操作

ナビゲーションは「概況」「承認待ち」「失敗」「依頼者」「ボット」を用意します。個別ジョブ画面には概要、本文または結果の明示表示、events と runs の履歴を表示します。

承認待ちには `status=queued` かつ `policy_decision=hold` のジョブだけを出します。失敗一覧には `status=failed` のジョブだけを出します。deny のジョブは失敗一覧にも承認待ちにも入れず、再実行できません。一覧と詳細では状態名、ジョブ ID、依頼者別名、作成時刻、試行回数、許可 capability の範囲、理由コードを表示できます。

各操作は 1 件ずつ確認ダイアログを経由します。一括承認は作りません。確認にはジョブ ID、依頼者別名、現在から変更後の状態、操作の説明を表示します。承認には保存済みの capability をそのまま表示します。空配列なら「許可 capability はありません」と表示します。画面から `allowed_capabilities` や `policy_decision` を編集できません。

却下は `queued` かつ `hold` のジョブだけに表示します。却下は `JobStore.cancel(jobId, {reason: 'owner_rejected'})` を呼びます。`policy_decision` を `deny` にしません。状態ラベルは「キャンセル済み」です。「お断り」にはしません。実行中ジョブに対する cancel 要求はダッシュボードから呼びません。

承認は `queued` かつ `hold` にだけ表示し、`JobStore.approve(jobId)` を呼びます。保存済み capability は変更しません。再実行は、`failed` かつ `attempts < max_attempts` かつ `policy_decision != deny` の場合にだけ表示し、`JobStore.retry(jobId, {reason: 'dashboard_retry'})` を呼びます。試行回数と上限を変更しません。deny に対して承認や再実行を試す API を提供しません。

操作要求には action_id UUID、操作名、読み取り時の expected 状態を含めます。expected は status、policy_decision、attempts、updated_at から成ります。確認ダイアログを開く時に UUID を 1 つ作ります。通信再試行では同じ UUID と同じ要求を送ります。別操作では新しい UUID を使います。サーバーは action_id と要求ハッシュを operator_actions で照合します。同じ UUID と同じ要求の再送には保存済み結果を返し、状態変更や job_events を増やしません。同じ UUID を異なるジョブ、操作、期待状態で使った場合は 409 ACTION_ID_REUSED です。

actions 要求の JSON は action_id、action、expected のみです。action は approve、reject、retry のいずれかです。reveal 要求の JSON は action_id と part のみです。part は request または result です。未知のキーは 400 で拒否します。

サーバーは書き込み用接続で期待状態を確認し、既存 JobStore メソッドの CAS を通します。iMessage の `/approve`、`/cancel`、`/retry` と競合した場合は、既存メソッドの CAS に先に成功した側だけが状態を変えます。期待状態が古い要求は変更せず 409 `STATE_CHANGED` と最新の安全な状態を返します。監査に `stale` または `rejected` を記録します。二重クリックや通信再試行でも操作を重ねません。

## HTTP 契約

JSON API の成功応答は必要な許可フィールドだけを含みます。エラーは `{error:{code,message}}` 形式で、秘密、本文、handle、SQL、スタックを含めません。未知ルートは 404 です。

| メソッドとパス | 認証 | 用途 |
|---|---|---|
| `GET /`、`GET /login` | 不要 | ログイン前はログイン画面、認証後は概況画面 |
| `GET /api/session` | セッション | CSRF nonce を含む `{csrfNonce}` を返す |
| `POST /login` | 不要 | JSON の token でログインし、セッションを作る |
| `POST /reauth` | セッション、CSRF | JSON の token を確認し、15 分以内の書き込み権限を再取得する |
| `POST /logout` | セッション、CSRF | セッションを破棄する |
| `GET /api/overview?period=...&dimension=...` | セッション | 集計、選択期間のバケット、前期間比較 |
| `GET /api/inbox/approvals` | セッション | 承認待ち一覧 |
| `GET /api/inbox/failures` | セッション | 失敗一覧 |
| `GET /api/jobs/:jobId` | セッション | 本文と結果を含まない詳細 |
| `GET /api/jobs/:jobId/trace` | セッション | events と runs の許可フィールド |
| `POST /api/jobs/:jobId/actions` | セッション、CSRF、15 分以内の再認証 | 承認、却下、再実行 |
| `POST /api/jobs/:jobId/reveal` | セッション、CSRF、15 分以内の再認証 | 明示指定した依頼本文か結果を表示し監査する |

`login` と `reauth` の JSON 本文は `token` だけを受け付けます。`actions` と `reveal` の要求形式は「画面と操作」の節に従います。`period` は `today`、`week`、`month` のいずれかです。`dimension` は `status`、`requester`、`bot` のいずれかです。不正な値は 400 です。読み取り API と画面は同一の集計、別名、許可フィールドを使います。

## レスポンシブ表示と状態

PC では 1280px 幅を基準に左ナビゲーションと概況カードを表示します。幅 390px では下部ナビゲーションを使い、期間カードと操作を縦に並べます。ページ全体に横スクロールを出しません。棒グラフの領域だけ横スクロールできます。

空の期間は合計 `0` と「該当するジョブはありません」を表示し、空のグラフに将来バケットを描きません。読み込み中は領域に `aria-busy=true` と「読み込み中」を表示します。読込失敗時は「更新できません」と再試行操作を表示します。古いデータが残っていても、更新に失敗した画面から状態変更できません。

実装時に `playwright` を devDependency に追加し、必要な install script を `allowScripts` で許可するか確認します。`npm test` は Vitest のユニットテストと API テストを実行します。API テストは Hono の `app.request()` を使い、ポートを listen しません。新しい `npm run test:ui` は Playwright の UI テストを実行します。Playwright がサーバーを起動する場合は通常のシェルまたは CI で実行し、Codex サンドボックス内では実行しません。Codex サンドボックスではポートの listen が `EPERM` で失敗します。Playwright は 1280px と 390px の主要状態のスクリーンショットを保存します。保存先は `SCREENSHOT_DIR` があればそこ、なければ OS の一時ディレクトリです。テストに `/workspace` などの機械固有パスを書きません。

## 後続段階

次の機能は初版に入れません。

- 保留、あきらめる、別ボットへの振り分け。
- Tailscale Serve、Funnel、tailnet からの公開。
- トークン数や費用の記録とグラフ化。
- 自然言語検索、OpenTelemetry、Slack 連携。
- 自動本番デプロイ、Mac mini への実インストール。

## GREEN when

各行を自動テストで判定します。HTTP は `app.request()`、時刻は注入時計、画面は Playwright で確認します。テストデータとスクリーンショットにはダミー値だけを使います。

| ID | 条件 | 置き場所の案 |
|---|---|---|
| D01 | `DASHBOARD_TOKEN` と `DASHBOARD_ALIAS_KEY` が未設定または 32 文字未満なら設定読込または起動が失敗し、設定値をログに出さない。各値が 32 文字以上なら受理する | `test/dashboard/config.test.ts` |
| D02 | `DASHBOARD_TOKEN` が `JOB_API_TOKEN` または `GENIE_TOKEN` と同じなら起動しない。エラーとログは値を含まない | `test/dashboard/config.test.ts` |
| D03 | `DASHBOARD_HOST` の既定値が `127.0.0.1`、既定ポートが `3322`。非 loopback、ポート範囲外、既存リスナーとのポート重複を拒否する | `test/dashboard/config.test.ts` |
| D04 | 未認証の HTML 要求は日本語ログイン画面、未認証の JSON API 要求は 401 を返す。`JOB_API_TOKEN` と `GENIE_TOKEN` ではログインできない | `test/dashboard/auth.test.ts` |
| D05 | 認証トークン値が HTML、JSON、Cookie、エラー応答、ログに出ない。ログイン要求本文もログに出ない | `test/dashboard/auth.test.ts` |
| D06 | ログイン後の Cookie は HttpOnly、SameSite=Strict、Path=/ で、保護 API にアクセスできる。期限切れまたは破棄済みセッションは拒否する | `test/dashboard/auth.test.ts` |
| D07 | ログイン後の認証 Cookie 付き `GET /api/session` は JSON で CSRF nonce を返す。認証済み POST は `X-CSRF-Token` ヘッダーで nonce を送り、Origin と Sec-Fetch-Site の検査も通る必要がある。値が欠けるか不正なら 403 になって DB を変えない | `test/dashboard/csrf.test.ts` |
| D08 | 再認証から 15 分以内の操作は受理される。15 分経過後は再ログインを要求し、再認証後にだけ書き込める | `test/dashboard/auth.test.ts` |
| D09 | 別名 HMAC は同一 sender_handle に同じ別名、異なる sender_handle に異なる別名を返す。JSON と HTML に生ハンドルを含めない | `test/dashboard/privacy.test.ts` |
| D10 | 新しい `openReadonlyDb` は v4 または v5 の `user_version`、テーブル定義、行を変更しない。読み取り専用接続で更新すると失敗し、ダッシュボードはマイグレーションを呼ばない。`openDb` を再利用しない | `test/dashboard/readonly-db.test.ts` |
| D11 | 注入時計を境界に固定し、今日、月曜始まりの今週、月初始まりの今月の開始と現在時刻を検査する。JST の境界を UTC エポックミリ秒に変換する。`created_at` が境界と等しいジョブが、境界から始まる名前付きバケットだけに入り、隣接バケットには入らないことを検証する | `test/dashboard/periods.test.ts` |
| D12 | 比較期間は昨日、先週の同じ曜日、先月の同じ日付と時刻までを含む。今日の期間と昨日の比較期間は端点を共有せず、昨日の比較終端は昨日の同じ時刻とする。前月に日付がなければ前月末までに切り詰める | `test/dashboard/periods.test.ts` |
| D13 | 今日の時間バケット、週と月の日バケットは半開区間 `[start, end)` とし、境界のジョブを後のバケットだけに入れる。現在の部分バケットは `[bucketStart, now]` として `created_at == now` を含め、未来のバケットを作らない | `test/dashboard/periods.test.ts` |
| D14 | 各期間カードに合計、前期間との差件数、割合を返す。前期間 0 件では「比較対象なし」とし、ゼロ除算しない | `test/dashboard/overview.test.ts` |
| D15 | 状態系列の名前が `statusLabel` の全状態名と一致し、各色が上記のダッシュボード色テーブルと一致する。名前は完了、承認待ち、失敗、お断り、キャンセル済み、実行中、受付済み | `test/dashboard/overview.test.ts` |
| D16 | 系列切替 status、requester、bot が同じ期間とバケットを使う。requester は別名だけを返し、bot は最大 attempt の worker_id を返す | `test/dashboard/overview.test.ts` |
| D17 | run のないジョブは bot 系列で「未着手」になる。同じジョブの複数 run は bot 系列で一度だけ数える | `test/dashboard/overview.test.ts` |
| D18 | 今日、今週、今月のどの選択でもトークン表示は「未記録」。応答にトークン数や推定費用を作らない | `test/dashboard/overview.test.ts` |
| D19 | 通常の一覧・詳細 HTML と JSON に依頼本文、結果、完全な error.message、sender_handle、source_chat_id、claim_token を含めない | `test/dashboard/privacy.test.ts` |
| D20 | 本文または結果の明示表示は要求した片方だけを mask と redactHandle に通して返し、文字列として表示する。API テストは `privacy.test.ts` で応答と監査行を検査し、Playwright は D31 でタグを含むダミー文字列が HTML として解釈されず、テキストノードとして表示されることを検査する。監査行には種別と action_id だけを保存し内容を残さない | `test/dashboard/privacy.test.ts`、`test/dashboard/ui.spec.ts` |
| D21 | 承認待ち受け箱は queued/hold だけを返し、成功後にジョブを一覧から外す。承認は `JobStore.approve` を通す | `test/dashboard/actions.test.ts` |
| D22 | 却下は queued/hold に限り、`JobStore.cancel` を呼ぶ。policy_decision は hold のまま、表示ラベルは「キャンセル済み」で「お断り」ではない | `test/dashboard/actions.test.ts` |
| D23 | 失敗受け箱は failed だけを返す。retry は attempts が上限未満かつ deny 以外だけ許可し、上限と attempts を変更しない | `test/dashboard/actions.test.ts` |
| D24 | dashboard が書く `operator_actions` の actor は `dashboard:owner`。job_events の承認 actor は `genie`、cancel/retry actor は `api` のまま | `test/dashboard/actions.test.ts` |
| D25 | 同一 action_id と同一要求の再送は保存済み結果を返し、状態変更、job_events、operator_actions を重複させない | `test/dashboard/actions.test.ts` |
| D26 | 同じ action_id を異なる要求に使うと 409 `ACTION_ID_REUSED` になり、状態を変えない | `test/dashboard/actions.test.ts` |
| D27 | expected が古い要求は 409 `STATE_CHANGED` と安全な現状態を返し、ジョブ状態と job_events を変えない | `test/dashboard/actions.test.ts` |
| D28 | iMessage `/approve` が先に成功した後の古い dashboard approve は状態を変えず、承認済み状態を返す。dashboard approve が先でも既存 iMessage の意味は変わらない | `test/dashboard/actions.test.ts` |
| D29 | 画面と API に一括承認、capability の追加、policy_decision の直接更新、deny の再実行経路がない | `test/dashboard/actions.test.ts` |
| D30 | trace は events と runs を返し、detail、本文、結果、ハンドル、チャット情報、claim token を含めない | `test/dashboard/jobs.test.ts` |
| D31 | `npm run test:ui` の Playwright 1280px テストで、ログイン前は「ログイン」、ログイン後は「概況」と期間ボタンの選択状態を確認する。空は「該当するジョブはありません」、読込中は aria-busy と「読み込み中」、エラーは「更新できません」と再試行ボタンを確認する。承認待ち、失敗、詳細では各見出しとジョブ ID を確認する。たとえば `本文 <em>ダミー</em>` のようにタグを含むダミー文字列を表示し、HTML 要素にならずテキストノードとして表示されることを確認する。各状態のスクリーンショットを保存する | `test/dashboard/ui.spec.ts` |
| D32 | `npm run test:ui` の Playwright 390px テストで D31 の主要状態のスクリーンショットを保存し、各状態でページ全体の scrollWidth が clientWidth を超えないことを確認する。グラフ領域内の横スクロールは許す | `test/dashboard/ui.spec.ts` |
| D33 | `npm run test:ui` のスクリーンショットは `SCREENSHOT_DIR` または OS の一時ディレクトリに保存し、テストに固定パスがない。外部 CDN、フォント、スクリプト、通信がない | `test/dashboard/ui.spec.ts`、`test/dashboard/hygiene.test.ts` |
| D34 | `npm run check:secrets` が通り、ソース、テスト、ログ例、コミット対象に実値の秘密、実 PII、tailnet 名または IP がない | `test/dashboard/hygiene.test.ts`、`npm run check:secrets` |
| D35 | `.env.example` にダッシュボード設定キーがすべてあり、値はダミーか空の別名表で、秘密や個人情報がない | `test/dashboard/hygiene.test.ts` |
| D36 | `DASHBOARD_ALIASES` は小文字 64 桁の HMAC キーと一意な `家族[A-Z]+` 表示名を受理する。不正な JSON、キー、重複名を値をログに出さず拒否する | `test/dashboard/config.test.ts` |
| D37 | v4 から v5 への移行で `operator_actions` だけを追加し、既存スキーマと行を保つ。再実行してもスキーマと `user_version` が変わらない | `test/dashboard/migration.test.ts` |
| D38 | operator_actions の監査行を書けない場合、ジョブ状態と job_events の変更もロールバックする。成功時は状態、job_events、監査が 1 回だけ保存される | `test/dashboard/actions.test.ts` |
