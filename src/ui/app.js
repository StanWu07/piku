let state, page = 'tasks', filter = 'todo', search = '', toastTimer;
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = { today: '今日概览', tasks: '全部待办', actions: '授权中心', history: '活动记录', settings: '助手设置' };
const kinds = { draft: '生成本地文稿', open_url: '打开网页', reminder: '设置提醒' };
const statuses = { pending: '待授权', executing: '执行中', done: '已执行', cancelled: '已取消', failed: '执行失败', uncertain: '需核实结果' };
const when = value => value ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未设置';
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
async function call(channel, data) {
  const result = await window.piku.call(channel, data);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function empty(title, message) { return `<div class="empty"><div class="empty-icon">◌</div><h3>${title}</h3><p>${message}</p></div>`; }
function heading(title, description, extra = '') { return `<div class="heading"><div><h1>${title}</h1><p>${description}</p></div>${extra}</div>`; }
const decisionLabels = { agent: '助手可完成', assisted: '助手可协助', human: '需要你完成' };
function judgmentLabel(task) {
  if (task.status === 'done') return '';
  const judgment = task.judgment;
  if (judgment?.status === 'ready') return decisionLabels[judgment.decision] || '待判断';
  if (judgment?.status === 'error') return '判断未完成';
  return judgment?.status === 'running' ? '正在判断分工…' : '';
}
function judgmentPanel(task) {
  if (task.status === 'done') return '';
  const judgment = task.judgment;
  if (!state.auth.connected && !judgment) return '<div class="judgment-panel"><p>登录 ChatGPT 后，可点击按钮判断助手能否执行。</p><button class="outline" data-judge-login="true">去登录</button></div>';
  if (!judgment) return `<div class="judgment-panel"><button class="outline" data-judge="${task.id}">判断助手能否执行</button><small>点击后分析这件事，可执行的动作仍需你确认。</small></div>`;
  if (judgment.status === 'running') return '<div class="judgment-panel" role="status">正在判断谁来完成，结果会显示在这里…</div>';
  if (judgment.status === 'error') return `<div class="judgment-panel"><p>暂时未能判断：${escape(judgment.error)}</p><button class="outline" data-judge="${task.id}">重新判断</button></div>`;
  const actions = (judgment.actionIds || []).map(id => state.actions.find(a => a.id === id)).filter(Boolean);
  return `<div class="judgment-panel"><strong>${decisionLabels[judgment.decision]}</strong><p>${escape(judgment.reason)}</p>${judgment.humanStep ? `<p class="human-step">你需要：${escape(judgment.humanStep)}</p>` : ''}${actions.map(action => `<div class="judgment-action"><span>${escape(action.title)}</span><button class="outline" data-action="${action.id}">${action.status === 'pending' ? '查看并确认' : action.status === 'done' ? '查看执行结果' : statuses[action.status]}</button></div>`).join('')}${actions.some(a => a.status === 'pending') ? '<small>先查看具体内容，你确认后助手才执行。</small>' : ''}</div>`;
}
function taskRow(task) {
  const focus = state.analysis?.focus.find(item => item.taskId === task.id);
  return `<div class="task-row ${task.status === 'done' ? 'done' : ''}"><button class="check ${task.status === 'done' ? 'checked' : ''}" data-complete="${task.id}" aria-label="${task.status === 'done' ? '重新打开' : '完成'} ${escape(task.title)}">${task.status === 'done' ? '✓' : ''}</button><div class="task-content"><button class="task-title" data-view="${task.id}">${escape(task.title)}</button><div class="task-meta">${judgmentLabel(task) ? `<span class="judgment-label">${judgmentLabel(task)}</span>` : ''}${task.dueAt ? `<span class="${Date.parse(task.dueAt) < Date.now() && task.status !== 'done' ? 'overdue' : ''}">◷ ${when(task.dueAt)} 截止</span>` : ''}${task.reminderAt ? `<span>♧ ${when(task.reminderAt)}${task.notifiedAt ? ' 已提醒' : ' 提醒'}</span>` : ''}</div>${focus && task.status !== 'done' ? `<div class="focus-step">✧ 建议：${escape(focus.nextStep)}</div>` : ''}</div></div>`;
}
function actionCard(action) { return `<article class="card"><span class="badge">✧ ${kinds[action.kind]} · ${statuses[action.status]}</span><h3>${escape(action.title)}</h3><p>${escape(action.reason)}</p><div class="card-footer"><small>${action.status === 'pending' ? '仅在你授权后执行' : when(action.finishedAt || action.createdAt)}</small><button class="outline" data-action="${action.id}">${action.status === 'pending' ? '查看并授权 →' : '查看详情 →'}</button></div></article>`; }
function sortedTasks() {
  const rank = { high: 0, medium: 1, low: 2 };
  return [...state.tasks].sort((a, b) => rank[a.priority] - rank[b.priority] || (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity));
}
function render() {
  if (!state) return;
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  $('#breadcrumb').innerHTML = `我的空间 <b>/</b> ${labels[page]}`;
  $('#connection').textContent = state.reviewing ? '✧ GPT 正在分析…' : state.auth.connected ? '○ ChatGPT 已登录' : state.auth.loginPending ? '◌ 等待登录…' : '○ 尚未登录 ChatGPT';
  const todos = sortedTasks().filter(t => t.status === 'todo');
  const pending = state.actions.filter(a => a.status === 'pending');
  $('#nav-count').textContent = todos.length; $('#action-count').textContent = pending.length;
  let html = '';
  if (page === 'tasks') {
    html = heading('待办清单', `${todos.length} 件未完成`, '<div class="record-actions"><button class="outline" data-command="add">文字记录</button><button class="primary" data-command="screenshot"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8"/></svg>截图记事</button></div>');
    html += `<div class="section-heading"><div class="tabs">${[['todo', '未完成'], ['done', '已完成'], ['all', '全部']].map(([id, name]) => `<button class="tab ${filter === id ? 'active' : ''}" data-filter="${id}">${name}</button>`).join('')}</div><input class="search" id="search" aria-label="搜索待办" placeholder="搜索待办…" value="${escape(search)}"></div><div class="task-list">${sortedTasks().filter(t => (filter === 'all' || t.status === filter) && `${t.title} ${t.notes}`.toLowerCase().includes(search.toLowerCase())).map(taskRow).join('') || empty('这里暂时没有待办', '换个筛选条件，或记下一件新的事情。')}</div>`;
  }
  if (page === 'actions') html = heading('助手建议', '由你确认后执行。', `<button class="primary" data-command="review" ${state.reviewing ? 'disabled' : ''}>${state.reviewing ? '正在分析…' : '分析我的待办'}</button>`) + `<div class="actions-grid">${state.actions.map(actionCard).join('') || `<div class="card">${empty('还没有执行建议', '先记录待办，再点击“分析我的待办”。')}</div>`}</div>`;
  if (page === 'history') html = heading('做过的事，都有迹可循。', '记录保存在这台电脑上，保留最近 300 条活动。') + `<div class="card">${state.logs.map(log => `<div class="log-row"><time>${when(log.at)}</time><span>${escape(log.message)}</span></div>`).join('') || empty('记录从这里开始', '添加、分析、提醒和执行操作都会记录在这里。')}</div>`;
  if (page === 'settings') html = heading('按照你的习惯，陪伴你。', '登录 ChatGPT，让助手帮你理清日常。') + `<form id="settings-form" class="settings"><div class="card"><div id="auth-panel">${authPanel()}</div><div class="field"><label for="model">使用的模型</label><select id="model" name="model">${modelOptions(state.settings.model)}</select></div><p>可用模型从账号读取。选择“自动选择”会使用 Codex 为账号提供的默认模型。</p></div><div class="card"><h3>陪伴方式</h3><label class="toggle"><input type="checkbox" name="autoReview" ${state.settings.autoReview ? 'checked' : ''}><div><strong>每小时自动分析未完成任务</strong><p>开启后会定期将待办发送至 OpenAI，使用账号对应的 Codex 额度。执行建议仍需你逐次授权。</p></div></label><label class="toggle"><input type="checkbox" name="launchAtLogin" ${state.settings.launchAtLogin ? 'checked' : ''}><div><strong>登录电脑时启动</strong><p>建议在打包后的 Piku 应用中开启。</p></div></label><div class="toggle"><div><strong>桌面提醒</strong><p>关闭窗口后继续在菜单栏运行；退出应用或关机时不会提醒，重新打开后补提醒。系统勿扰模式可能隐藏通知。</p></div><button type="button" class="outline" data-command="test-notification">测试提醒</button></div></div><button class="primary" type="submit">保存设置</button></form>`;
  $('#content').innerHTML = html;
}
function authPanel() {
  const auth = state.auth;
  return `<h3>ChatGPT 账号</h3><p>在官方页面登录后，即可使用账号对应的 Codex 权益。可用性和额度取决于你的套餐；分析时会将相关待办发送至 OpenAI。</p>${auth.connected ? `<div class="account-box"><span class="account-symbol">✳</span><div><strong>${escape(auth.account?.email || '已登录 ChatGPT')}</strong><small>${escape(auth.account?.plan || '当前账号')} · 登录由 Codex 管理</small></div><span class="pill">已连接</span></div>` : `<div class="hint">${auth.loginPending ? '浏览器已打开官方登录页面。完成登录后，这里会自动更新。' : '点击下方按钮，在浏览器中登录你的 ChatGPT 账号。账号密码不会进入 Piku。'}</div>`}${auth.error ? `<p class="auth-error" role="status">${escape(auth.error)}</p>` : ''}<div class="auth-buttons">${auth.connected ? '<button type="button" class="outline" data-command="logout">退出登录</button>' : auth.loginPending ? '<button type="button" class="outline" data-command="cancel-login">取消登录</button>' : '<button type="button" class="primary" data-command="login">使用 ChatGPT 登录 ↗</button>'}<button type="button" class="text-button" data-command="refresh-auth">刷新连接</button></div><p>登录状态独立保存在 Piku 中，退出不会影响其他应用。</p>`;
}
function modelOptions(selected) {
  return '<option value="">自动选择（账号默认模型）</option>' + (selected && !state.auth.models.some(m => m.id === selected) ? `<option value="${escape(selected)}" selected disabled>${escape(selected)} · 暂不可用</option>` : '') + state.auth.models.map(m => `<option value="${escape(m.id)}" ${selected === m.id ? 'selected' : ''}>${escape(m.name)}${m.isDefault ? ' · 默认' : ''}</option>`).join('');
}
function openModal(html) { $('#modal-body').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); }
function modalHeader(title, subtitle) { return `<div class="modal-header"><h2>${title}</h2><button class="close" data-command="close" aria-label="关闭">×</button></div><p class="subtitle">${subtitle}</p>`; }
function localDate(value) { if (!value) return ''; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function taskDetails(id) {
  const task = state.tasks.find(t => t.id === id); if (!task) return;
  openModal(`<article class="task-detail"><div class="modal-header"><span class="detail-status">${task.status === 'done' ? '已完成' : '未完成'}</span><button class="close" data-command="close" aria-label="关闭">×</button></div><h2>${escape(task.title)}</h2>${task.dueAt ? `<p class="detail-date">截止时间 · ${when(task.dueAt)}</p>` : ''}${task.notes ? `<div class="detail-notes">${escape(task.notes)}</div>` : ''}<section data-judgment-id="${id}">${judgmentPanel(task)}</section><div class="modal-actions"><button class="outline" data-edit="${id}">编辑</button><button class="primary" data-detail-complete="${id}">${task.status === 'done' ? '重新打开' : '标记完成'}</button></div></article>`);
}
function taskModal(id) {
  const task = state.tasks.find(t => t.id === id) || { title: '', notes: '' };
  openModal(modalHeader(id ? '编辑待办' : '记下一件事', '写一句话，按回车就记好了。') + `<form id="task-form" data-id="${id || ''}"><div class="field"><label class="sr-only" for="title">要做什么</label><input id="title" class="quick-title" name="title" maxlength="200" value="${escape(task.title)}" placeholder="要做什么？" required autofocus></div><details class="task-extra deadline-field" ${task.dueAt ? 'open' : ''}><summary>截止时间（选填）</summary><div class="deadline-input"><input aria-label="截止时间" type="datetime-local" name="dueAt" value="${localDate(task.dueAt)}"><button type="button" class="text-button" data-command="clear-deadline">清除</button></div><p class="note">没有期限的事情，直接留在待办清单里。</p></details>${id ? `<details class="task-extra" open><summary>补充说明${task.notes ? ' · 已填写' : '（选填）'}</summary><textarea aria-label="补充说明" name="notes" maxlength="12000" placeholder="需要时再补充…">${escape(task.notes)}</textarea></details>` : ''}<div class="modal-actions">${id ? `<button type="button" class="danger" data-delete="${id}">删除待办</button>` : ''}<button type="button" class="outline" data-command="close">取消</button><button class="primary" type="submit">${id ? '保存修改' : '添加待办'}</button></div></form>`);
  $('#title').focus();
}
function pasteModal() { openModal(modalHeader('把消息，变成清楚的待办', '粘贴会议笔记、聊天消息或随手记录。提取结果会先交给你确认。') + '<form id="extract-form"><div class="field"><textarea name="text" maxlength="20000" rows="8" placeholder="例如：明天下午三点前给我一份项目进度说明，别忘了下班后取快递…" required></textarea></div><div class="hint">这段消息会发送给 OpenAI 分析。提取结果不会直接执行任何操作。</div><div class="modal-actions"><button type="button" class="outline" data-command="close">取消</button><button class="primary" type="submit">✧ 提取待办</button></div></form>'); }
function actionModal(id) {
  const action = state.actions.find(a => a.id === id); if (!action) return;
  const task = state.tasks.find(t => t.id === action.taskId);
  const content = action.kind === 'draft' ? action.content : action.kind === 'open_url' ? action.url : when(action.reminderAt);
  openModal(modalHeader(escape(action.title), `${kinds[action.kind]} · ${statuses[action.status]} · 关联待办：${escape(task?.title || '已删除')}`) + `<p class="subtitle">${escape(action.reason)}</p><pre class="draft-preview">${escape(content)}</pre><div class="hint">${action.kind === 'draft' ? '授权后将以上完整内容保存为本地 Markdown 文稿。原待办的完成状态由你确认。' : action.kind === 'open_url' ? '授权后将在系统浏览器中打开上方地址。' : '授权后将用上方时间替换这条待办的现有提醒。'}</div>${action.error ? `<p class="subtitle">${escape(action.error)}</p>` : ''}<div class="modal-actions">${action.status === 'pending' ? `<button class="outline" data-reject="${id}">拒绝建议</button><button class="primary" data-approve="${id}">授权并执行</button>` : action.kind === 'draft' && action.status === 'done' ? `<button class="primary" data-reveal="${id}">在 Finder 中查看文稿</button>` : '<button class="outline" data-command="close">关闭</button>'}</div>`);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.page) { page = button.dataset.page; if (page === 'tasks') { filter = 'todo'; search = ''; } render(); }
    if (button.dataset.filter) { filter = button.dataset.filter; render(); }
    if (button.dataset.judge) { button.disabled = true; await call('task:judge', button.dataset.judge); }
    if (button.dataset.judgeLogin) { $('#modal').close(); page = 'settings'; render(); }
    if (button.dataset.view) taskDetails(button.dataset.view);
    if (button.dataset.detailComplete) { const task = state.tasks.find(t => t.id === button.dataset.detailComplete); button.disabled = true; await call('task:update', { id: task.id, patch: { status: task.status === 'todo' ? 'done' : 'todo' } }); $('#modal').close(); }
    if (button.dataset.edit) taskModal(button.dataset.edit);
    if (button.dataset.action) actionModal(button.dataset.action);
    if (button.dataset.complete) { const task = state.tasks.find(t => t.id === button.dataset.complete); await call('task:update', { id: task.id, patch: { status: task.status === 'todo' ? 'done' : 'todo' } }); }
    if (button.dataset.delete) {
      const id = button.dataset.delete;
      openModal(modalHeader('删除这条待办？', '关联的待授权建议也会取消。此操作无法撤销。') + `<div class="modal-actions"><button class="outline" data-edit="${id}">保留待办</button><button class="primary" data-confirm-delete="${id}">确认删除</button></div>`);
    }
    if (button.dataset.confirmDelete) { await call('task:remove', button.dataset.confirmDelete); $('#modal').close(); toast('待办已删除'); }
    if (button.dataset.approve) { button.disabled = true; const result = await call('action:execute', button.dataset.approve); actionModal(result.id); toast(result.status === 'done' ? '执行完成，已记入活动记录' : result.error); }
    if (button.dataset.reject) { await call('action:cancel', button.dataset.reject); $('#modal').close(); toast('已拒绝这条建议'); }
    if (button.dataset.reveal) await call('draft:reveal', button.dataset.reveal);
    document.querySelector('.more-menu').open = false;
    const command = button.dataset.command;
    if (command === 'reload') { state = await call('state:get'); render(); }
    if (command === 'add') taskModal();
    if (command === 'screenshot') await call('capture:start');
    if (command === 'clear-deadline') { const field = $('#task-form [name=dueAt]'); field.value = ''; $('.deadline-field').open = false; $('#title').focus(); }
    if (command === 'paste') { if (!state.auth.connected) { page = 'settings'; render(); toast('先登录 ChatGPT，就可以提取待办了'); } else pasteModal(); }
    if (command === 'close') $('#modal').close();
    if (command === 'review') { if (!state.auth.connected) { page = 'settings'; render(); toast('先登录 ChatGPT，就可以分析待办了'); } else { button.disabled = true; await call('ai:review'); toast('分析完成，看看下一步建议吧'); } }
    if (command === 'login') { button.disabled = true; await call('auth:login'); toast('请在浏览器中完成官方登录'); }
    if (command === 'cancel-login') { button.disabled = true; await call('auth:cancel'); toast('已取消登录'); }
    if (command === 'refresh-auth') { button.disabled = true; await call('auth:refresh'); toast('连接状态已更新'); }
    if (command === 'logout') { button.disabled = true; await call('auth:logout'); state = await call('state:get'); render(); toast('已退出 Piku 的 ChatGPT 账号'); }
    if (command === 'test-notification') { await call('notification:test'); toast('已请求系统通知；若未显示，请检查系统通知设置'); }
  } catch (error) { toast(error.message); } finally { if (button.isConnected) button.disabled = false; }
});
document.addEventListener('input', event => { if (event.target.id === 'search') { const position = event.target.selectionStart; search = event.target.value; render(); $('#search').focus(); $('#search').setSelectionRange(position, position); } });
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const button = form.querySelector('[type="submit"]'); if (button.disabled) return; button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    if (form.id === 'task-form') {
      data.dueAt = data.dueAt ? new Date(data.dueAt).toISOString() : null;
      if (form.dataset.id) await call('task:update', { id: form.dataset.id, patch: data }); else await call('task:add', data);
      $('#modal').close(); toast('已保存，这件事交给清单记住');
    }
    if (form.id === 'settings-form') { await call('settings:save', { ...data, autoReview: data.autoReview === 'on', launchAtLogin: data.launchAtLogin === 'on' }); state = await call('state:get'); render(); toast('设置已保存'); }
    if (form.id === 'extract-form') {
      button.textContent = '正在提取…';
      const tasks = await call('ai:extract', data.text);
      if (!$('#modal').open || !form.isConnected) { toast('提取已完成，但输入窗口已关闭，请重新打开后提取'); return; }
      openModal(modalHeader(`发现 ${tasks.length} 条待办`, '勾选要加入清单的事项。加入后可点击任务修改时间和详情。') + `<form id="import-form">${tasks.map((task, index) => `<label class="extract-row"><input type="checkbox" name="task" value="${index}" checked><span>${escape(task.title)}<br><small>${escape(task.notes)}<br>截止：${when(task.dueAt)} · 提醒：${when(task.reminderAt)}</small></span></label>`).join('') || '<p class="subtitle">没有找到明确待办，请补充具体要做的事情。</p>'}<div class="modal-actions"><button type="button" class="outline" data-command="close">取消</button><button class="primary" type="submit">加入清单</button></div></form>`);
      $('#import-form').tasks = tasks;
    }
    if (form.id === 'import-form') {
      const indexes = new FormData(form).getAll('task');
      for (const index of indexes) { await call('task:add', form.tasks[Number(index)]); form.querySelector(`input[value="${index}"]`).disabled = true; }
      $('#modal').close(); toast(`已加入 ${indexes.length} 条待办`);
    }
  } catch (error) { toast(error.message); } finally { if (button.isConnected) { button.disabled = false; if (form.id === 'extract-form') button.textContent = '✧ 提取待办'; } }
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); taskModal(); } });
window.piku.onState(next => {
  state = next;
  const panel = document.querySelector('[data-judgment-id]');
  if (panel && $('#modal').open) { const task = state.tasks.find(t => t.id === panel.dataset.judgmentId); if (task) panel.innerHTML = judgmentPanel(task); else $('#modal').close(); }
  if (page !== 'settings' || !$('#settings-form')) render();
  else {
    $('#auth-panel').innerHTML = authPanel();
    const selected = $('#model').value; $('#model').innerHTML = modelOptions(selected);
    $('#connection').textContent = state.auth.connected ? '○ ChatGPT 已登录' : state.auth.loginPending ? '◌ 等待登录…' : '○ 尚未登录 ChatGPT';
  }
});
window.piku.onNotice(toast);
window.piku.onNavigate(nextPage => { if (labels[nextPage]) { page = nextPage; render(); } });
call('state:get').then(next => { state = next; render(); }).catch(error => { $('#content').innerHTML = `<div class="empty"><h3>待办暂时未能加载</h3><p>${escape(error.message)}</p><button class="primary" data-command="reload">重新加载</button></div>`; });
