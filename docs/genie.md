# Genie との契約

Job Engine は Mac mini 上で Genie 用の Ingress と Worker 用の Job API を別々に待ち受ける。Ingress は loopback だけに公開し、Genie 専用の `GENIE_TOKEN` で認証する。Job API のトークンは使えない。設定手順は [README](../README.md)、Worker の経路は [worker.md](worker.md) を参照する。

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
6. `/help`、`/status <job_id>`、`/cancel <job_id>`、`/retry <job_id>` を管理コマンドとして処理する。未知のスラッシュコマンドや形が違うコマンドには使い方を返す。
7. それ以外をジョブとして作り、201 `{"status":"created","job_id":"J-000001"}` を返す。

ジョブの source は `imessage`、source_message_id は guid、source_chat_id は chat_id の 10 進文字列、requester_id は `self`、job_type は `general`。`GENIE_ALLOWED_CHAT_IDS` の値は `ALLOWED_SOURCE_CHAT_IDS` にも必要。request_text は印を除いた本文で、設定の文字数上限を適用する。

受付のジョブ、ack outbox、`ingress_messages` の記録は同じトランザクションで作る。ack のキーは `job:<job_id>:ack`。本文は仕様 13.4 の受付文で、プレビューはコードポイントで先頭 40 字。受信記録には guid、chat_id、kind、job_id、outbox_id、received_at、created_at を残す。コマンド名も `command` 列に保存し、同じ guid に本文を変えて再送されても前回の応答を返せる。原文と sender_name はログに残さず、受信記録にも本文を保存しない。

## 管理コマンド

コマンドの HTTP 応答は `{"status":"command","command":"status"}` の形。command は先頭のスラッシュを除いた `help`、`status`、`cancel`、`retry`。不正な形は `help` にする。

返信は `kind='command'`、`channel='genie'`、キー `cmd:<guid>` の outbox に入れる。ジョブがない `/help` や見つからないジョブへの返信では job_id は null。送り先と返信元 guid は、そのコマンドのメッセージから保存する。

`/status` はジョブ ID、日本語の状態、試行回数、キャンセル要求の有無を返す。状態の表記は受付済み、実行中、完了、失敗、キャンセル済み。`/cancel` と `/retry` は Job API と同じ状態遷移を使う。実行中の cancel はキャンセル要求を立てる。retry の上限では「再実行の上限に達しています」と返す。

コマンドが参照できるのは source_chat_id が同じジョブだけ。別のトークのジョブと存在しないジョブは、どちらも「見つかりません」と返す。再送ではコマンドを再実行しない。

## 返信取得と cursor

Genie の `reply_fetch_url` は `http://127.0.0.1:3321/genie/replies` にする。`reply-secret` に `GENIE_TOKEN` と同じ値を設定する。現在の Genie は URL を HTTPS に制限しているため、webhook と返信取得の loopback HTTP を認める変更が Genie 側に必要。Job Engine から Genie のソースは変更しない。

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
