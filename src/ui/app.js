let state, page = 'today', filter = 'todo', search = '', toastTimer;
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = { today: '今日概览', tasks: '全部待办', actions: '授权中心', history: '活动记录', settings: '助手设置' };
const categories = { work: '工作', life: '生活', growth: '成长' };
const priorities = { high: '高优先级', medium: '中优先级', low: '低优先级' };
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
function heading(title, description, extra = '') { return `<div class="heading"><div><div class="eyebrow">YOUR EVERYDAY, A LITTLE LIGHTER</div><h1>${title}</h1><p>${description}</p></div>${extra}</div>`; }
function taskRow(task) {
  const focus = state.analysis?.focus.find(item => item.taskId === task.id);
  return `<div class="task-row ${task.status === 'done' ? 'done' : ''}"><button class="check ${task.status === 'done' ? 'checked' : ''}" data-complete="${task.id}" aria-label="${task.status === 'done' ? '重新打开' : '完成'} ${escape(task.title)}">${task.status === 'done' ? '✓' : ''}</button><div class="task-content"><button class="task-title" data-edit="${task.id}">${escape(task.title)}</button><div class="task-meta"><span class="tag ${task.category}">${categories[task.category]}</span>${task.dueAt ? `<span class="${Date.parse(task.dueAt) < Date.now() && task.status !== 'done' ? 'overdue' : ''}">◷ ${when(task.dueAt)} 截止</span>` : '<span>无截止时间</span>'}${task.reminderAt ? `<span>♧ ${when(task.reminderAt)}${task.notifiedAt ? ' 已提醒' : ' 提醒'}</span>` : ''}</div>${focus && task.status !== 'done' ? `<div class="focus-step">✧ 建议：${escape(focus.nextStep)}</div>` : ''}</div><span class="priority ${task.priority}"><i></i>${priorities[task.priority]}</span></div>`;
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
  if (page === 'today') {
    const hour = new Date().getHours();
    const greeting = hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    html = heading(`${greeting}，把琐事放在这里。`, '一起理清待办，让今天从容一点。', `<span class="date-badge">◷ ${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span>`);
    html += `<section class="hero"><div class="hero-symbol">✳</div><div><h2>${state.analysis ? '今天，先把精力放在重要的事上' : '你的待办，我来帮你理一理'}</h2><p>${escape(state.analysis?.summary || '记下脑海中的大小事。Piku 会帮你判断轻重缓急，\n拆解下一步，并在合适的时候提醒你。')}</p></div><button class="primary" data-command="review" ${state.reviewing ? 'disabled' : ''}>✧ ${state.reviewing ? '正在分析…' : '分析我的待办'}</button></section>`;
    html += `<div class="stats"><div class="stat"><span class="stat-icon">☷</span><div><small>未完成的事</small><strong>${todos.length}<span>件待办</span></strong></div></div><div class="stat"><span class="stat-icon">◷</span><div><small>即将提醒</small><strong>${todos.filter(t => t.reminderAt && !t.notifiedAt).length}<span>件事项</span></strong></div></div><div class="stat"><span class="stat-icon">✓</span><div><small>已经完成</small><strong>${state.tasks.filter(t => t.status === 'done').length}<span>件，很棒</span></strong></div></div></div>`;
    html += `<div class="columns"><section><div class="section-heading"><h2>接下来要做 <span>一步一步来</span></h2><button class="text-button" data-page="tasks">全部待办 ↗</button></div><div class="task-list">${todos.slice(0, 5).map(taskRow).join('') || empty('从记下一件小事开始', '工作安排、生活琐事、突然想到的事，<br>都可以先放在这里。')}<button class="add-row" data-command="add">＋ 添加一条待办</button></div><div class="capture"><span>❝</span><p>有一大段消息？让 Piku 帮你提取待办。</p><button data-command="paste">粘贴消息 ↗</button></div></section><section><div class="section-heading"><h2>助手建议 <span>${pending.length ? pending.length + ' 项待授权' : '由你做决定'}</span></h2><span class="pill">✧ AI</span></div>${pending.slice(0, 2).map(actionCard).join('') || `<div class="card">${empty('需要时，帮你搭把手', '分析待办后，可执行的建议会出现在这里。你可以先查看，再决定是否授权。')}</div>`}<p class="note">♧ 每一次执行都有记录。<br>你可以随时拒绝尚未执行的建议。</p></section></div>`;
  }
  if (page === 'tasks') {
    html = heading('把所有事情，安放好。', '点击任务可修改详情、截止日期和提醒时间。', '<button class="primary" data-command="add">＋ 添加待办</button>');
    html += `<div class="section-heading"><div class="tabs">${[['todo', '未完成'], ['done', '已完成'], ['all', '全部']].map(([id, name]) => `<button class="tab ${filter === id ? 'active' : ''}" data-filter="${id}">${name}</button>`).join('')}</div><input class="search" id="search" aria-label="搜索待办" placeholder="搜索待办…" value="${escape(search)}"></div><div class="task-list">${sortedTasks().filter(t => (filter === 'all' || t.status === filter) && `${t.title} ${t.notes}`.toLowerCase().includes(search.toLowerCase())).map(taskRow).join('') || empty('这里暂时没有待办', '换个筛选条件，或记下一件新的事情。')}</div>`;
  }
  if (page === 'actions') html = heading('让助手，帮你完成一步。', '查看每个动作的完整内容，再选择授权或拒绝。') + `<div class="actions-grid">${state.actions.map(actionCard).join('') || `<div class="card">${empty('还没有执行建议', '先记录待办，再点击“分析我的待办”。')}</div>`}</div>`;
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
function taskModal(id) {
  const task = state.tasks.find(t => t.id === id) || { title: '', notes: '', category: 'life', priority: 'medium' };
  openModal(modalHeader(id ? '把这件事安排好' : '记下一件事', '先放下脑海里的事情，剩下的慢慢安排。') + `<form id="task-form" data-id="${id || ''}"><div class="field"><label for="title">要做什么</label><input id="title" name="title" maxlength="200" value="${escape(task.title)}" placeholder="例如：整理下周的项目汇报" required autofocus></div><div class="field"><label for="notes">补充信息</label><textarea id="notes" name="notes" maxlength="12000" placeholder="背景、要求，或需要打开的网页链接…">${escape(task.notes)}</textarea></div><div class="form-row"><div class="field"><label>分类</label><select name="category">${Object.entries(categories).map(([id, name]) => `<option value="${id}" ${task.category === id ? 'selected' : ''}>${name}</option>`).join('')}</select></div><div class="field"><label>优先级</label><select name="priority">${Object.entries(priorities).map(([id, name]) => `<option value="${id}" ${task.priority === id ? 'selected' : ''}>${name}</option>`).join('')}</select></div></div><div class="form-row"><div class="field"><label>截止时间（可选）</label><input type="datetime-local" name="dueAt" value="${localDate(task.dueAt)}"></div><div class="field"><label>提醒时间（可选）</label><input type="datetime-local" name="reminderAt" value="${localDate(task.reminderAt)}"></div></div><div class="modal-actions">${id ? `<button type="button" class="danger" data-delete="${id}">删除待办</button>` : ''}<button type="button" class="outline" data-command="close">取消</button><button class="primary" type="submit">${id ? '保存修改' : '添加待办'}</button></div></form>`);
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
    if (button.dataset.page) { page = button.dataset.page; render(); }
    if (button.dataset.filter) { filter = button.dataset.filter; render(); }
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
    const command = button.dataset.command;
    if (command === 'add') taskModal();
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
      for (const field of ['dueAt', 'reminderAt']) data[field] = data[field] ? new Date(data[field]).toISOString() : null;
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
  if (page !== 'settings' || !$('#settings-form')) render();
  else {
    $('#auth-panel').innerHTML = authPanel();
    const selected = $('#model').value; $('#model').innerHTML = modelOptions(selected);
    $('#connection').textContent = state.auth.connected ? '○ ChatGPT 已登录' : state.auth.loginPending ? '◌ 等待登录…' : '○ 尚未登录 ChatGPT';
  }
});
window.piku.onNotice(toast);
call('state:get').then(next => { state = next; render(); }).catch(error => toast(error.message));
