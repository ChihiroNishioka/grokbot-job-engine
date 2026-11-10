# 動作確認の状況

## 実装済み

Job Store、Job API、Genie 用 Ingress と返信取得、Reconciler、Worker クライアントと CLI を実装しています。Dispatcher は合図の契約とモックがあります。main.ts は Dispatcher を起動しません。Worker は手動または外部から呼び出す必要があります。

## 確認した範囲

HTTP のテストは Hono の `app.request()` を使い、サーバーの待ち受けは実行していません。DB は一時ファイルとメモリ上で確認しています。

Transport は偽の spawn のみで確認しています。EOF で終了する偽の子プロセスを使った 1 往復と、標準入力を EOF にせず Content-Length または chunked の終端まで応答を読む動作を検証しています。実際の tailscale nc は未実行です。Genie との実配送は未実行です。これらの経路は実機で未確認です。

GitHub Actions は private リポジトリで runner が起動しないため、box の通常シェルで同じ手順を実行しています。手順は `npm run lint`、`npm run typecheck`、`npm test`、`npm run check:secrets`、`npm run build` です。実行ごとの結果は Git 管理外の `.runs/` に記録します。

Genie との接続には genie-in-messages の別 PR、ブランチ `feat/job-engine-route` のマージが必要です。設定は [Genie との契約](genie.md) にあります。
