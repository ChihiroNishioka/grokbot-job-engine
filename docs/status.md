# 動作確認の状況

## 実装済み

Job Store、Job API、Genie 用 Ingress と返信取得、Reconciler、Worker クライアントと CLI を実装しています。Dispatcher は合図の契約とモックがあります。main.ts は Dispatcher を起動しません。Worker は手動または外部から呼び出す必要があります。

## 確認した範囲

HTTP のテストは Hono の `app.request()` を使い、サーバーの待ち受けは実行していません。DB は一時ファイルとメモリ上で確認しています。

Transport は偽の spawn のみで確認しています。EOF で終了する偽の子プロセスを使った 1 往復と、標準入力を EOF にせず Content-Length または chunked の終端まで応答を読む動作を検証しています。実際の tailscale nc と IPv6 の実通信、Genie 経由の /status の実配送は実機で未確認です。実プロセスの stdin は box で確認済みです。URLページングと元トークの表示制限は app.request() による確認であり、Messages への配送確認は含みません。

GitHub Actions は private リポジトリで runner が起動しないため、box の通常シェルで同じ手順を実行しています。手順は `npm run lint`、`npm run typecheck`、`npm test`、`npm run check:secrets`、`npm run build` です。実行ごとの結果は Git 管理外の `.runs/` に記録します。

Genie との接続には genie-in-messages の別 PR、ブランチ `feat/job-engine-route` のマージが必要です。設定は [Genie との契約](genie.md) にあります。

## 送信者ハンドルの実機確認

送信者ハンドルと家族グループ受付は実機で未確認です。imsgが返すsenderの形、家族の端末からGenie経由で受付・Worker claim・完了まで配送されること、オーナーの管理コマンド、家族のコマンドが無返信となることを確認する必要があります。ログとdeadletterの漏えい検査は実際の値を共有せず、あり・なしだけ記録してください。

実DBのバックアップとv4移行、DBコピーを旧版で開けないこと、Routineが `allowed_capabilities` の範囲内だけで動くこと、CLIの出力が会話記録へ残る範囲、グループ返信のレート制限も未確認です。有効化の前にRoutineが capability 制限を構造的に守ることをオーナーが確認してください。Job Engine 側では決定的な分類、claim 条件、complete の `used_capabilities` 検査を実装済みですが、Routine の実装はこのリポジトリ外です。
