export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Job Engine オーナー画面</title>
  <link rel="stylesheet" href="/assets/dashboard.css">
  <script src="/assets/dashboard.js" defer></script>
</head>
<body>
  <div class="app-shell">
    <section id="login-view" class="login-card" aria-labelledby="login-title">
      <p class="eyebrow">JOB ENGINE</p>
      <h1 id="login-title">ログイン</h1>
      <p>オーナー用の画面です。</p>
      <form id="login-form">
        <label for="login-token">ダッシュボードトークン</label>
        <input id="login-token" name="token" type="password" autocomplete="current-password" required>
        <button class="primary-button" type="submit">ログイン</button>
      </form>
      <p id="login-message" class="message" role="alert" hidden></p>
    </section>
    <section id="owner-view" class="owner-view" hidden>
      <aside class="sidebar">
        <a class="brand" href="/" aria-label="Job Engine 概況"><span class="brand-mark">J</span><span>Job Engine</span></a>
        <nav class="side-nav" aria-label="メインナビゲーション">
          <button type="button" data-page="overview">概況</button>
          <button type="button" data-page="approvals">承認待ち</button>
          <button type="button" data-page="failures">失敗</button>
          <button type="button" data-page="requesters">依頼者</button>
          <button type="button" data-page="bots">ボット</button>
        </nav>
        <div class="sidebar-footer"><span class="owner-label">本人としてログイン中</span><button id="logout-button" class="quiet-button" type="button">ログアウト</button></div>
      </aside>
      <main id="main-content" class="main-content" tabindex="-1">
        <header class="topbar">
          <div><p class="eyebrow">JOB ENGINE</p><h1 id="page-title">概況</h1></div>
          <button id="refresh-button" class="quiet-button" type="button">更新</button>
        </header>
        <section id="page-content" aria-live="polite" aria-busy="false"></section>
      </main>
      <nav class="mobile-nav" aria-label="メインナビゲーション">
        <button type="button" data-page="overview"><span aria-hidden="true">⌂</span>概況</button>
        <button type="button" data-page="approvals"><span aria-hidden="true">✓</span>承認待ち</button>
        <button type="button" data-page="failures"><span aria-hidden="true">!</span>失敗</button>
        <button type="button" data-page="requesters"><span aria-hidden="true">人</span>依頼者</button>
        <button type="button" data-page="bots"><span aria-hidden="true">●</span>ボット</button>
      </nav>
    </section>
    <dialog id="reauth-dialog" class="dialog-card">
      <form id="reauth-form" method="dialog">
        <h2>再ログインが必要です</h2>
        <p>操作を続けるには、ダッシュボードトークンを入力してください。</p>
        <label for="reauth-token">ダッシュボードトークン</label>
        <input id="reauth-token" name="token" type="password" autocomplete="current-password" required>
        <p id="reauth-message" class="message" role="alert" hidden></p>
        <div class="dialog-actions"><button class="quiet-button" value="cancel">戻る</button><button class="primary-button" type="submit">再ログイン</button></div>
      </form>
    </dialog>
    <dialog id="action-dialog" class="dialog-card">
      <form id="action-form" method="dialog">
        <h2 id="action-title">操作の確認</h2>
        <div id="action-summary" class="action-summary"></div>
        <p id="action-message" class="message" role="alert" hidden></p>
        <div class="dialog-actions"><button class="quiet-button" value="cancel">戻る</button><button id="action-confirm" class="primary-button" type="submit">実行する</button></div>
      </form>
    </dialog>
  </div>
</body>
</html>`;
}
