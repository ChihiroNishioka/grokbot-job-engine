# Genie との契約

実装済みと未確認の範囲は [動作確認の状況](status.md) を参照してください。

Job Engine は Mac mini 上で Genie 用の Ingress と Worker 用の Job API を別々に待ち受ける。Ingress は loopback だけに公開し、Genie 専用の `GENIE_TOKEN` で認証する。Job API のトークンは使えない。設定手順は [README](../README.md)、Worker の経路は [worker.md](worker.md) を参照する。

## Genie 側を設定する

Genie 側は genie-in-messages の別 PR、ブランチ `feat/job-engine-route` が前提です。この PR で `job_webhook_url`、`job_chat_ids`、`job-secret`、loopback の http 許可、Notion と並べた返信取得が入ります。PR がマージされるまでは今の Genie では使えません。

Genie の設定（`config.json`）に足すキーの例は次のとおりです。`job_chat_ids` の数は、Mac mini 上で自分宛てトークの chat_id に置き換えます（Job Engine 側の `GENIE_ALLOWED_CHAT_IDS` と `ALLOWED_SOURCE_CHAT_IDS` にも同じ値が要ります。無いと Genie は `webhook_http_403` で止めます）。

```json
{
  "job_webhook_url": "http://127.0.0.1:3321/ingress/genie",
  "job_chat_ids": [7],
  "reply_fetch_url": "http://127.0.0.1:3321/genie/replies"
}
```

`job-secret` と `reply-secret` には `GENIE_TOKEN` と同じ値を保存し、両ファイルの権限を `0600` にします。通常の `webhook_url` と Notion の設定は今のままです。ジョブ専用の webhook と返信取得を追加します。

## Webhook の受け付け

`POST /ingress/genie` は `Authorization: Bearer <GENIE_TOKEN>` を要求する。レート制限、本文サイズ上限、エラー形式は Job API と共通。`GET /healthz` だけは認証不要。

本文は次の形の JSON で、未知のキーを受け付けない。

```json
{
  "v": 1,
  "event": "message",
  "idempotency_key": "dummy-message-guid",
  "guid": "dummy-message-guid",
  "chat_id": 21,
  "text": "🪔 依頼本文",
  "created_at": null,
  "sender_is_me": true,
  "sender_name": "dummy-self"
}
```

`guid` と `idempotency_key` は同じ値で、長さは 1〜256 字。`chat_id` は安全に表現できる整数。`created_at` は文字列か null で、キーが無くてもよい（Genie の Swift の JSONEncoder は nil の optional のキーを省略するため）。

受け付ける順番は次のとおり。

1. 許可外の chat_id を 403 `CHAT_NOT_ALLOWED` にする。Genie は通常の 4xx を再送しない。
2. `sender_is_me=false` は 200 `{"status":"ignored","reason":"not_from_me"}` にする。
3. 先頭の空白・不可視文字と先頭の 🪔、その直後の variation selector と空白を除く。残った先頭が性別なしを含む 🧞 なら `reason:"bot_reply"` として無視する。
4. 残りが空なら `reason:"empty"` として無視する。
5. 同じ guid の受付があれば、前回と同じ JSON を 200 で返す。ジョブ、コマンド、副作用を追加しない。許可済みの別 chat_id で同じ guid を使った場合は 409 にする。
6. 文字数上限を超える本文は 200 `{"status":"rejected","reason":"too_long"}` とし、キー `cmd:<guid>` の返信「依頼が長すぎます（最大 N 字）。短くして送り直してください。」を同じトランザクションで記録する。同じ guid の再送は返信を増やさない。
7. `/help`、`/status <job_id>`、`/cancel <job_id>`、`/retry <job_id>` を管理コマンドとして処理する。前後の空白・改行・全角スペースを除いて判定する。既知のコマンドで ID が無いか形が違う場合は「コマンドを読めませんでした。」と使い方を返す。それ以外のスラッシュで始まる依頼は通常のジョブになる。
8. それ以外をジョブとして作り、201 `{"status":"created","job_id":"J-000001"}` を返す。

ジョブの source は `imessage`、source_message_id は guid、source_chat_id は chat_id の 10 進文字列、requester_id は `self`、job_type は `general`。`GENIE_ALLOWED_CHAT_IDS` の値は `ALLOWED_SOURCE_CHAT_IDS` にも必要。request_text は印を除いた本文で、設定の文字数上限を適用する。

受付のジョブ、ack outbox、`ingress_messages` の記録は同じトランザクションで作る。ack のキーは `job:<job_id>:ack`。本文は仕様 13.4 の受付文で、プレビューはコードポイントで先頭 40 字。受信記録には guid、chat_id、kind、job_id、outbox_id、received_at、created_at を残す。コマンド名も `command` 列に保存し、同じ guid に本文を変えて再送されても前回の応答を返せる。原文と sender_name はログに残さず、受信記録にも本文を保存しない。

## 管理コマンド

コマンドの HTTP 応答は `{"status":"command","command":"status"}` の形。command は先頭のスラッシュを除いた `help`、`status`、`cancel`、`retry`。不正な形は `help` にする。

返信は `kind='command'`、`channel='genie'`、キー `cmd:<guid>` の outbox に入れる。ジョブがない `/help` や見つからないジョブへの返信では job_id は null。送り先と返信元 guid は、そのコマンドのメッセージから保存する。

`/status` はジョブ ID、日本語の状態、試行回数、キャンセル要求の有無を返す。状態の表記は受付済み、実行中、完了、失敗、キャンセル済み。`/cancel` と `/retry` は Job API と同じ状態遷移を使う。実行中の cancel はキャンセル要求を立てる。retry の上限では「再実行の上限に達しています」と返す。

コマンドが参照できるのは source_chat_id が同じジョブだけ。別のトークのジョブと存在しないジョブは、どちらも「ジョブが見つかりません。」と返す。再送ではコマンドを再実行しない。

## 返信取得と cursor

上記の別 PR を適用した Genie は、`reply_fetch_url` から Notion と並べてジョブの返信を取得する。認証は `reply-secret` を使う。

```http
GET /genie/replies?cursor=o:42
Authorization: Bearer <GENIE_TOKEN>
```

応答は Genie の `HTTPReplySource` が読む形にする。

```json
{
  "cursor": "o:43",
  "replies": [
    {
      "id": "je-43",
      "chat_id": 21,
      "text": "ジョブ J-000001 が完了しました。",
      "in_reply_to_guid": "dummy-message-guid",
      "created_at": "2026-11-11T00:00:00.000Z"
    }
  ]
}
```

`id` は outbox 行 ID ごとの `je-<outbox_id>`。同じ元 guid への ack と done も別の reply id になる。chat_id は数値。in_reply_to_guid はジョブでは元の source_message_id、コマンドではコマンドの guid。created_at は outbox の作成時刻。Genie は元 guid に対応する route を使って送り先を決め、chat_id との一致や route の期限も検証する。

取得対象は `channel='genie'` かつ `status='pending'` で cursor より大きい行。outbox_id の昇順で `GENIE_REPLY_PAGE_LIMIT` 件まで返す。既定は 50 件、範囲は 1〜100。cursor は `o:<非負の整数>` の形で、安全に表現できる整数だけを認める。壊れた形は 400。

返す cursor は最後の outbox_id。行がなければ受け取った cursor を返し、要求に cursor がなければ null。同じ cursor のまま取り直すと、次ページは未処理のまま返る。Genie はページの全返信を処理した後だけ cursor を進める。

`cursor=o:N` を受け取ると、N 以下の pending の genie 行を、取得と同じトランザクションで sent にする。external_ref は `genie:cursor`。`outbox.sent` イベントの actor は `genie`。ジョブの列は変更しない。繰り返し同じ cursor を受け取ってもイベントを重複させない。

ここで sent は「Genie が受け取って処理した」を意味する。Genie は期限切れや route 不明で捨てた返事も処理済みとするため、Messages に送れたことを保証しない。送信の成否は Genie のログで確認する。Genie から送信結果を返す仕組みは次の段階の候補。

返信は最大 1500 コードポイントに切る。🧞‍♂️ を先頭に付けない。Genie の ReplyComposer が 1 通目に印だけを送り、本文を別に送るため。先頭を 🪔 にもしない。

Genie 由来のジョブでは追加の enqueue と complete/fail の notify も genie channel に入る。`/outbox/claim` は genie 行を取得しない。Reconciler の staleOutbox は genie 行も報告する。

完了文は固定文と成果物 URL を先に確保し、結果の可変部分だけを切って1500字以内にします。失敗文の原因は error.code から固定の安全な文を作り、未知のコードは「処理中にエラーが起きました」とします。例外の message はマスクして error にだけ保存します。cancelled の返信は「ジョブ J-… はキャンセルしました。」で、retry は案内しません。

/help は各コマンドの説明を返します。cancel は「キャンセルしました。」または「キャンセルを受け付けました。実行中の処理が止まるのを待っています。」、retry は「再実行を受け付けました。」と状態を返します。

complete / fail と Reconciler の終端通知は `job:<job_id>:<kind>:<attempt>` をキーにします。Reconciler は既存の genie channel の outbox があるジョブを Genie 経由と判定し、lease 切れで failed / cancelled にしたときに同じトランザクションで通知を作ります。

成果物 URL と固定文だけで1500字を超える場合は、URLを切らず `ARTIFACT_NOTIFICATION_TOO_LONG` を返します。Worker は `outcome:"notification_error"` と job_id、code を返し、complete / fail は送らず claim を保持します。CLI は終了コード2と同じ理由コードを返します。短い URL か明示的な短い `notify` で完了してください。CLI では `--no-notify` も使えます。API の成果物保存上限は変更しません。
