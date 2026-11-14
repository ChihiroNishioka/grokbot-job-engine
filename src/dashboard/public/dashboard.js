const loginView = document.getElementById('login-view');
const ownerView = document.getElementById('owner-view');
const loginForm = document.getElementById('login-form');
const loginMessage = document.getElementById('login-message');
const content = document.getElementById('page-content');
const title = document.getElementById('page-title');
const reauthDialog = document.getElementById('reauth-dialog');
const reauthForm = document.getElementById('reauth-form');
const reauthMessage = document.getElementById('reauth-message');
const actionDialog = document.getElementById('action-dialog');
const actionForm = document.getElementById('action-form');
const actionTitle = document.getElementById('action-title');
const actionSummary = document.getElementById('action-summary');
const actionMessage = document.getElementById('action-message');
const actionConfirm = document.getElementById('action-confirm');
let csrfNonce = '';
let pendingAction = null;
let pendingReveal = null;
let mutationsEnabled = false;
const state = { page: 'overview', period: 'today', dimension: 'status', selectedBucket: null, selectedSeries: null, detail: null };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setMessage(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

function widthClass(value) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  const className = `dashboard-width-${percent}`;
  const sheet = [...document.styleSheets].find(item => item.href === `${location.origin}/assets/dashboard.css`);
  if (sheet && !sheet.cssRules.some(rule => rule.cssText.startsWith(`.${className} `) || rule.cssText.startsWith(`.${className}{`))) {
    try { sheet.insertRule(`.${className}{width:${percent}%}`, sheet.cssRules.length); } catch { return ''; }
  }
  return className;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (csrfNonce && options.method === 'POST' && path !== '/login') headers.set('X-CSRF-Token', csrfNonce);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

function showLogin(message = '') {
  loginView.hidden = false;
  ownerView.hidden = true;
  setMessage(loginMessage, message);
}

async function enterOwner() {
  const { response, result } = await api('/api/session');
  if (!response.ok || typeof result.csrfNonce !== 'string') {
    showLogin();
    return;
  }
  csrfNonce = result.csrfNonce;
  loginView.hidden = true;
  ownerView.hidden = false;
  await loadOverview();
}

function setActivePage(page) {
  for (const button of document.querySelectorAll('[data-page]')) {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function busy() {
  mutationsEnabled = false;
  content.setAttribute('aria-busy', 'true');
  content.replaceChildren(element('div', 'loading-state', '読み込み中'));
}

function failed() {
  content.setAttribute('aria-busy', 'false');
  const box = element('div', 'error-state');
  box.append(element('p', '', '更新できません'));
  const retry = element('button', 'primary-button', '再試行');
  retry.type = 'button';
  retry.addEventListener('click', loadCurrentPage);
  box.append(retry);
  content.replaceChildren(box);
}

function statusClass(job) {
  if (job.status === 'done') return 'status-pill status-done';
  if (job.status === 'failed') return 'status-pill status-failed';
  if (job.status === 'claimed') return 'status-pill status-running';
  if (job.status === 'cancelled' && job.expected.policy_decision === 'deny') return 'status-pill status-denied';
  if (job.status_label === '承認待ち') return 'status-pill status-pending';
  return 'status-pill';
}

function formatDate(value) {
  if (!value) return '日時未記録';
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function capabilityList(job) {
  const wrap = element('div', 'capability-list');
  if (!job.allowed_capabilities || job.allowed_capabilities.length === 0) {
    wrap.append(element('span', 'capability', '許可 capability はありません'));
    return wrap;
  }
  for (const capability of job.allowed_capabilities) wrap.append(element('span', 'capability', capability));
  return wrap;
}

function openAction(job, action) {
  pendingAction = {
    action_id: crypto.randomUUID(),
    action,
    expected: job.expected,
    job_id: job.job_id,
    job,
  };
  const labels = { approve: ['承認の確認', '承認待ちから受付済みにします。'], reject: ['却下の確認', '承認待ちをキャンセル済みにします。'], retry: ['再実行の確認', '失敗したジョブを再実行待ちにします。'] };
  actionTitle.textContent = labels[action][0];
  actionSummary.replaceChildren();
  actionSummary.append(element('p', '', `ジョブ ID：${job.job_id}`));
  actionSummary.append(element('p', '', `依頼者：${job.requester}`));
  actionSummary.append(element('p', '', `状態：${job.status_label} → ${action === 'approve' ? '受付済み' : action === 'reject' ? 'キャンセル済み' : '受付済み'}`));
  actionSummary.append(element('p', '', labels[action][1]));
  if (action === 'approve') actionSummary.append(capabilityList(job));
  actionConfirm.textContent = '実行する';
  setMessage(actionMessage, '');
  actionDialog.showModal();
}

function jobRow(job, allowActions = false) {
  const row = element('article', 'job-row');
  const top = element('div', 'job-row-top');
  const open = element('button', 'job-open', job.job_id);
  open.type = 'button';
  open.addEventListener('click', () => loadJob(job.job_id));
  top.append(open, element('span', statusClass(job), job.status_label));
  row.append(top);
  const meta = element('div', 'job-meta');
  meta.append(element('span', '', job.requester));
  meta.append(element('span', '', formatDate(job.created_at)));
  meta.append(element('span', '', `試行 ${job.attempts}/${job.max_attempts}`));
  if (job.reason_code) meta.append(element('span', '', `理由コード ${job.reason_code}`));
  row.append(meta);
  if (job.allowed_capabilities !== null) row.append(capabilityList(job));
  if (allowActions) {
    const actions = element('div', 'job-actions');
    if (job.can_approve) actions.append(actionButton('承認する', job, 'approve'));
    if (job.can_reject) actions.append(actionButton('却下する', job, 'reject'));
    if (job.can_retry) actions.append(actionButton('再実行する', job, 'retry'));
    if (actions.childElementCount > 0) row.append(actions);
  }
  return row;
}

function actionButton(label, job, action) {
  const button = element('button', '', label);
  button.type = 'button';
  button.disabled = !mutationsEnabled;
  button.addEventListener('click', () => openAction(job, action));
  return button;
}

function jobList(jobs, allowActions = false) {
  const list = element('div', 'data-list');
  if (jobs.length === 0) {
    list.append(element('div', 'empty-state', '該当するジョブはありません'));
    return list;
  }
  for (const job of jobs) list.append(jobRow(job, allowActions));
  return list;
}

function renderCards(data) {
  const cards = element('div', 'period-cards');
  for (const period of ['today', 'week', 'month']) {
    const card = data.cards[period];
    const labels = { today: '今日', week: '今週', month: '今月' };
    const button = element('button', 'period-card');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.period === period));
    button.append(element('span', 'period-card-label', labels[period]));
    button.append(element('span', 'period-total', `${card.total} 件`));
    const delta = card.difference === 0 ? '±0件' : `${card.difference > 0 ? '+' : ''}${card.difference}件`;
    button.append(element('span', 'period-difference', `前期間比 ${delta}`));
    button.append(element('span', 'period-percent', card.percent === null ? '比較対象なし' : `${card.percent > 0 ? '+' : ''}${card.percent}%`));
    button.addEventListener('click', () => { state.period = period; state.selectedBucket = null; loadOverview(); });
    cards.append(button);
  }
  return cards;
}

function renderTabs(items, selected, onSelect, className = 'period-tabs') {
  const tabs = element('div', className);
  for (const [key, label] of items) {
    const button = element('button', 'tab-button', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selected === key));
    button.addEventListener('click', () => onSelect(key));
    tabs.append(button);
  }
  return tabs;
}

function renderChart(data) {
  const panel = element('section', 'panel');
  const heading = element('div', 'panel-heading');
  heading.append(element('h2', '', state.dimension === 'status' ? '状態の推移' : state.dimension === 'requester' ? '依頼者の推移' : 'ボットの推移'));
  heading.append(renderTabs([['status', '状態'], ['requester', '依頼者'], ['bot', 'ボット']], state.dimension, value => {
    state.dimension = value;
    state.selectedBucket = null;
    loadOverview();
  }, 'dimension-tabs'));
  panel.append(heading);
  const legend = element('div', 'legend');
  for (const series of data.series) {
    const button = element('button', 'legend-button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.selectedSeries === series.id));
    const dot = element('span', 'series-dot color-' + series.color.slice(1));
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot, element('span', '', series.label));
    button.addEventListener('click', () => { state.selectedSeries = state.selectedSeries === series.id ? null : series.id; renderOverview(data); });
    legend.append(button);
  }
  panel.append(legend);
  const max = Math.max(1, ...data.buckets.map(bucket => Object.values(bucket.counts).reduce((sum, count) => sum + count, 0)), ...data.buckets.map(bucket => bucket.previous_total ?? 0));
  const scroller = element('div', 'chart-scroll');
  const chart = element('div', 'chart');
  chart.setAttribute('role', 'group');
  chart.setAttribute('aria-label', '期間ごとのジョブ数');
  data.buckets.forEach((bucket, index) => {
    const button = element('button', 'bucket-button');
    button.type = 'button';
    button.setAttribute('aria-label', `${bucket.label} ${Object.values(bucket.counts).reduce((sum, count) => sum + count, 0)}件`);
    button.setAttribute('aria-pressed', String(state.selectedBucket === index));
    const total = Object.values(bucket.counts).reduce((sum, count) => sum + count, 0);
    button.append(element('span', 'bucket-total', String(total)));
    const track = element('span', 'chart-track');
    const stack = element('span', 'chart-stack');
    for (const series of data.series) {
      const count = bucket.counts[series.id] ?? 0;
      if (!count) continue;
      const segment = element('span', `bar-segment color-${series.color.slice(1)} ${widthClass(count / max * 100)}`);
      segment.setAttribute('aria-label', `${series.label} ${count}件`);
      stack.append(segment);
    }
    track.append(stack);
    if (bucket.previous_total !== null) {
      const previous = element('span', `previous-line ${widthClass(bucket.previous_total / max * 100)}`);
      previous.title = `前期間 ${bucket.previous_total}件`;
      previous.setAttribute('aria-label', `前期間 ${bucket.previous_total}件`);
      track.append(previous);
    }
    button.append(track, element('span', 'bucket-label', bucket.label));
    button.addEventListener('click', () => { state.selectedBucket = state.selectedBucket === index ? null : index; state.selectedSeries = null; renderOverview(data); });
    chart.append(button);
  });
  scroller.append(chart);
  panel.append(scroller, element('p', 'chart-note', '棒を選ぶと、その期間のジョブを表示します。細線は前期間の合計です。'));
  return panel;
}

function renderBotMetrics(data) {
  if (state.dimension !== 'bot' || data.bot_metrics.length === 0) return null;
  const panel = element('section', 'panel');
  panel.append(element('h2', '', 'ボットの実行状況'));
  const table = element('table', 'bot-metrics');
  const head = element('thead', '');
  const headerRow = element('tr', '');
  for (const label of ['ボット', '最終 run のジョブ', 'run 数', '成功', '失敗']) headerRow.append(element('th', '', label));
  head.append(headerRow);
  table.append(head);
  const body = element('tbody', '');
  for (const metric of data.bot_metrics) {
    const row = element('tr', '');
    for (const value of [metric.worker_id, String(metric.last_run_jobs), String(metric.run_count), String(metric.success_count), String(metric.failure_count)]) row.append(element('td', '', value));
    body.append(row);
  }
  table.append(body);
  panel.append(table);
  return panel;
}

function renderOverview(data) {
  mutationsEnabled = true;
  content.setAttribute('aria-busy', 'false');
  content.replaceChildren();
  content.append(renderTabs([['today', '今日'], ['week', '今週'], ['month', '今月']], state.period, value => {
    state.period = value;
    state.selectedBucket = null;
    loadOverview();
  }));
  content.append(renderCards(data));
  const panel = renderChart(data);
  content.append(panel);
  const botPanel = renderBotMetrics(data);
  if (botPanel) content.append(botPanel);
  const selected = state.selectedBucket === null ? data.jobs : (data.buckets[state.selectedBucket]?.jobs ?? []).map(item => item.job);
  const filtered = state.selectedSeries === null ? selected : selected.filter(job => {
    if (state.dimension === 'requester') return `requester:${job.requester}` === state.selectedSeries;
    if (state.dimension === 'bot') return `bot:${job.bot_worker_id ?? '未着手'}` === state.selectedSeries;
    return `status:${job.status_label}` === state.selectedSeries;
  });
  const listPanel = element('section', 'panel');
  listPanel.append(element('h2', '', state.selectedBucket === null ? 'ジョブ' : `ジョブ ${data.buckets[state.selectedBucket]?.label ?? ''}`));
  listPanel.append(jobList(filtered));
  content.append(listPanel);
  const note = element('p', 'token-note', `トークン数：${data.tokens}`);
  content.append(note);
  state.selectedSeries = null;
}

function renderInbox(jobs) {
  mutationsEnabled = true;
  content.setAttribute('aria-busy', 'false');
  content.replaceChildren(jobList(jobs, true));
}

function detailPanel(job, trace) {
  const panel = element('section', 'panel');
  const list = element('dl', 'detail-grid');
  const values = [
    ['状態', job.status_label], ['依頼者', job.requester], ['作成日時', formatDate(job.created_at)],
    ['試行回数', `${job.attempts}/${job.max_attempts}`], ['理由コード', job.reason_code ?? 'なし'],
  ];
  for (const [label, value] of values) {
    const item = element('div', '');
    item.append(element('dt', '', label), element('dd', '', value));
    list.append(item);
  }
  const capabilities = element('div', '');
  capabilities.append(element('dt', '', '許可 capability'), element('dd', ''));
  capabilities.lastElementChild.append(capabilityList(job));
  list.append(capabilities);
  panel.append(list);
  if (job.request_present) panel.append(revealButton(job, 'request', '本文を表示'));
  if (job.result_present) panel.append(revealButton(job, 'result', '結果を表示'));
  if (job.can_approve || job.can_reject || job.can_retry) {
    const actions = element('div', 'job-actions');
    if (job.can_approve) actions.append(actionButton('承認する', job, 'approve'));
    if (job.can_reject) actions.append(actionButton('却下する', job, 'reject'));
    if (job.can_retry) actions.append(actionButton('再実行する', job, 'retry'));
    panel.append(actions);
  }
  const tracePanel = element('section', 'panel');
  tracePanel.append(element('h2', '', '履歴'));
  const entries = element('div', 'trace-list');
  for (const event of trace.events) {
    const row = element('div', 'trace-row');
    row.append(element('span', 'trace-time', `${formatDate(event.at)} ${event.type}`));
    row.append(element('span', '', `${event.actor} ${event.from_status ?? '開始'} → ${event.to_status ?? ''}${event.reason_code ? `・${event.reason_code}` : ''}`));
    entries.append(row);
  }
  for (const run of trace.runs) {
    const row = element('div', 'trace-row');
    row.append(element('span', 'trace-time', `${formatDate(run.started_at)} run ${run.attempt}`));
    row.append(element('span', '', `${run.worker_id}・${run.outcome}${run.error_code ? `・${run.error_code}` : ''}`));
    entries.append(row);
  }
  if (entries.childElementCount === 0) entries.append(element('p', 'empty-state', '履歴はありません'));
  tracePanel.append(entries);
  return [panel, tracePanel];
}

function revealButton(job, part, label) {
  const button = element('button', 'quiet-button reveal-button', label);
  button.type = 'button';
  button.disabled = !mutationsEnabled;
  button.addEventListener('click', () => reveal(job.job_id, part));
  return button;
}

async function loadOverview() {
  state.page = state.dimension === 'requester' ? 'requesters' : state.dimension === 'bot' ? 'bots' : 'overview';
  const titles = { overview: '概況', requesters: '依頼者', bots: 'ボット' };
  title.textContent = titles[state.page];
  setActivePage(state.page);
  busy();
  try {
    const { response, result } = await api(`/api/overview?period=${state.period}&dimension=${state.dimension}`);
    if (!response.ok) { failed(); return; }
    renderOverview(result);
  } catch { failed(); }
}

async function loadInbox(kind) {
  state.page = kind;
  title.textContent = kind === 'approvals' ? '承認待ち' : '失敗';
  setActivePage(kind);
  busy();
  try {
    const { response, result } = await api(`/api/inbox/${kind}`);
    if (!response.ok || !Array.isArray(result.jobs)) { failed(); return; }
    renderInbox(result.jobs);
  } catch { failed(); }
}

async function loadJob(jobId) {
  state.page = 'detail';
  title.textContent = `ジョブ ${jobId}`;
  setActivePage('');
  busy();
  try {
    const [jobResponse, traceResponse] = await Promise.all([api(`/api/jobs/${encodeURIComponent(jobId)}`), api(`/api/jobs/${encodeURIComponent(jobId)}/trace`)]);
    if (!jobResponse.response.ok || !traceResponse.response.ok) { failed(); return; }
    state.detail = jobResponse.result.job;
    mutationsEnabled = true;
    content.setAttribute('aria-busy', 'false');
    content.replaceChildren(...detailPanel(state.detail, traceResponse.result));
  } catch { failed(); }
}

async function loadCurrentPage() {
  if (state.page === 'overview' || state.page === 'requesters' || state.page === 'bots') return loadOverview();
  if (state.page === 'approvals' || state.page === 'failures') return loadInbox(state.page);
  if (state.page === 'detail' && state.detail) return loadJob(state.detail.job_id);
}

function showReauth() {
  setMessage(reauthMessage, '');
  if (!reauthDialog.open) reauthDialog.showModal();
  document.getElementById('reauth-token').focus();
}

async function sendPendingAction() {
  if (!pendingAction) return;
  actionConfirm.textContent = '再送する';
  try {
    const { response, result } = await api(`/api/jobs/${encodeURIComponent(pendingAction.job_id)}/actions`, { method: 'POST', body: JSON.stringify({ action_id: pendingAction.action_id, action: pendingAction.action, expected: pendingAction.expected }) });
    if (result.error?.code === 'REAUTH_REQUIRED') { showReauth(); return; }
    if (!response.ok) {
      setMessage(actionMessage, result.error?.message ?? '操作できませんでした。状態を更新してください。');
      if (result.error?.code === 'STATE_CHANGED') await loadCurrentPage();
      return;
    }
    const page = state.page;
    actionDialog.close();
    pendingAction = null;
    if (page === 'approvals' || page === 'failures') await loadInbox(page);
    else if (state.detail) await loadJob(state.detail.job_id);
  } catch {
    setMessage(actionMessage, '通信できません。もう一度送信してください。');
  }
}

async function reveal(jobId, part) {
  if (!pendingReveal || pendingReveal.job_id !== jobId || pendingReveal.part !== part) {
    pendingReveal = { job_id: jobId, part, action_id: crypto.randomUUID() };
  }
  try {
    const { response, result } = await api(`/api/jobs/${encodeURIComponent(jobId)}/reveal`, { method: 'POST', body: JSON.stringify({ action_id: pendingReveal.action_id, part }) });
    if (result.error?.code === 'REAUTH_REQUIRED') { showReauth(); return; }
    if (!response.ok) {
      if (result.error?.code === 'CONTENT_NOT_AVAILABLE') return;
      failed();
      return;
    }
    const output = element('pre', 'reveal-text');
    output.textContent = result.text;
    const panel = content.querySelector('.panel');
    if (panel) panel.append(output);
    pendingReveal = null;
  } catch {
    const current = content.querySelector('.panel');
    if (current) {
      const retry = element('button', 'quiet-button reveal-button', '表示を再試行');
      retry.type = 'button';
      retry.addEventListener('click', () => reveal(jobId, part));
      current.append(retry);
    }
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.getElementById('login-token');
  const value = input.value;
  input.value = '';
  setMessage(loginMessage, '');
  try {
    const { response } = await api('/login', { method: 'POST', body: JSON.stringify({ token: value }) });
    if (!response.ok) { showLogin('トークンを確認してください。'); return; }
    await enterOwner();
  } catch { showLogin('ログインできませんでした。'); }
});

reauthForm.addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.getElementById('reauth-token');
  const value = input.value;
  input.value = '';
  try {
    const { response } = await api('/reauth', { method: 'POST', body: JSON.stringify({ token: value }) });
    if (!response.ok) { setMessage(reauthMessage, 'トークンを確認してください。'); return; }
    reauthDialog.close();
    if (pendingAction) await sendPendingAction();
    else if (pendingReveal) await reveal(pendingReveal.job_id, pendingReveal.part);
  } catch { setMessage(reauthMessage, '再ログインできませんでした。'); }
});

actionForm.addEventListener('submit', event => { event.preventDefault(); void sendPendingAction(); });
for (const button of document.querySelectorAll('[data-page]')) {
  button.addEventListener('click', () => {
    const page = button.dataset.page;
    if (page === 'overview') { state.dimension = 'status'; void loadOverview(); }
    else if (page === 'requesters') { state.dimension = 'requester'; void loadOverview(); }
    else if (page === 'bots') { state.dimension = 'bot'; void loadOverview(); }
    else if (page === 'approvals' || page === 'failures') void loadInbox(page);
  });
}
document.getElementById('refresh-button').addEventListener('click', loadCurrentPage);
document.getElementById('logout-button').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: '{}' }).catch(() => null);
  csrfNonce = '';
  showLogin();
});

void enterOwner();
