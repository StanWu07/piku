const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, shell, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { CodexClient, ChatGPTService } = require('./codex.cjs');
const { Store, extract, analyze, execute, dueReminders } = require('./core.cjs');
app.setName('Piku');
if (!app.isPackaged && process.env.PIKU_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.PIKU_TEST_USER_DATA));
let window, tray, store, chatgpt, quitting = false, reviewing = false, reviewRetryAfter = 0;
const uiUrl = pathToFileURL(path.join(__dirname, 'ui/index.html')).href;
function publicState() {
  return { ...store.state, auth: chatgpt.snapshot(), reviewing, notificationsSupported: Notification.isSupported() };
}
function publish() { if (window && !window.isDestroyed()) window.webContents.send('state', publicState()); }
function aiOptions() { return { generate: request => chatgpt.generate(request), model: store.state.settings.model }; }
function show() { if (!window || window.isDestroyed()) createWindow(); window.show(); window.focus(); }
function notify(title, body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', show); notification.show();
}
async function review() {
  if (reviewing) throw new Error('正在分析，请稍候');
  if (!store.state.tasks.some(t => t.status === 'todo')) throw new Error('先添加一条待办吧');
  const options = aiOptions();
  reviewing = true; publish();
  const snapshot = JSON.stringify(store.state.tasks);
  try {
    const result = await analyze(JSON.parse(snapshot), options);
    if (snapshot !== JSON.stringify(store.state.tasks)) throw new Error('分析期间任务发生变化，请重新分析');
    store.state.analysis = { summary: result.summary, focus: result.focus, at: new Date().toISOString() };
    // Keep already reviewed proposals stable; a later analysis never silently changes their payload.
    for (const proposal of result.actions) {
      if (!store.state.actions.some(a => a.taskId === proposal.taskId && a.kind === proposal.kind && ['pending', 'executing'].includes(a.status))) {
        store.state.actions.unshift({ ...proposal, id: randomUUID(), status: 'pending', createdAt: new Date().toISOString() });
      }
    }
    store.state.lastReviewAt = new Date().toISOString(); store.log('GPT 已完成待办分析'); store.save();
  } finally { reviewing = false; publish(); }
}
function bind(channel, handler) {
  ipcMain.handle(channel, async (event, data) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== uiUrl) return { ok: false, error: '来源不受信任' };
    try { const result = await handler(data); publish(); return { ok: true, data: result }; }
    catch (error) { return { ok: false, error: error.name === 'TimeoutError' ? '请求超时，请检查网络后重试' : error.message }; }
  });
}
function createWindow() {
  window = new BrowserWindow({ width: 1320, height: 860, minWidth: 1000, minHeight: 700, title: 'Piku · 日常助手', backgroundColor: '#f6f7f9', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 21 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.loadURL(uiUrl);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
}
async function tick() {
  for (const task of dueReminders(store)) {
    try {
      notify('Piku · 该处理这件事了', task.title);
      task.notifiedAt = new Date().toISOString(); store.log(`提醒已触发：${task.title}`); store.save(); publish();
    } catch { /* Retry on the next tick when the notification backend is unavailable. */ }
  }
  if (store.state.settings.autoReview && chatgpt.status.connected && !reviewing && Date.now() > reviewRetryAfter && (!store.state.lastReviewAt || Date.now() - Date.parse(store.state.lastReviewAt) > 3600000) && store.state.tasks.some(t => t.status === 'todo')) {
    const previous = store.state.actions.filter(a => a.status === 'pending').length;
    try { await review(); if (store.state.actions.filter(a => a.status === 'pending').length > previous) notify('Piku · 有新的执行建议', '查看具体内容后，即可决定是否授权。'); }
    catch (error) { reviewRetryAfter = Date.now() + 3600000; store.log(`后台分析失败：${error.message}`); store.save(); publish(); }
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'));
    // Migration: the removed API transport must not retain its saved credential.
    const legacyCredential = path.join(store.directory, 'credential.bin');
    if (fs.existsSync(legacyCredential)) fs.unlinkSync(legacyCredential);
    chatgpt = new ChatGPTService({ client: new CodexClient({ directory: path.join(store.directory, 'chatgpt') }), onChange: publish });
    bind('auth:refresh', () => chatgpt.refresh());
    bind('auth:login', () => chatgpt.login(url => shell.openExternal(url)));
    bind('auth:cancel', () => chatgpt.cancelLogin());
    bind('auth:logout', async () => { await chatgpt.logout(); store.state.settings.autoReview = false; store.save(); });
    bind('state:get', () => publicState());
    bind('task:add', data => store.add(data));
    bind('task:update', data => store.update(data.id, data.patch));
    bind('task:remove', id => store.remove(id));
    bind('ai:extract', text => extract(text, aiOptions()));
    bind('ai:review', review);
    bind('action:execute', id => execute(store, id, {
      openUrl: url => shell.openExternal(url),
      writeDraft: (id, title, content) => {
        const directory = path.join(store.directory, 'drafts'); fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${id}.md`); fs.writeFileSync(file, `# ${title}\n\n${content}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); return file;
      }
    }));
    bind('action:cancel', id => {
      const action = store.state.actions.find(a => a.id === id);
      if (!action || action.status !== 'pending') throw new Error('该建议已处理');
      action.status = 'cancelled'; store.log(`已拒绝：${action.title}`); store.save();
    });
    bind('draft:reveal', id => {
      const action = store.state.actions.find(a => a.id === id && a.kind === 'draft' && a.status === 'done');
      if (!action) throw new Error('文稿不存在'); shell.showItemInFolder(action.result);
    });
    bind('settings:save', data => {
      if (typeof data.model !== 'string' || (data.model && !chatgpt.status.models.some(model => model.id === data.model))) throw new Error('请选择当前账号可用的模型');
      if (data.autoReview && !chatgpt.status.connected) throw new Error('登录 ChatGPT 后才能开启后台分析');
      if (Boolean(data.launchAtLogin) !== store.state.settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: Boolean(data.launchAtLogin) });
      store.state.settings = { authMode: 'chatgpt', model: data.model, autoReview: Boolean(data.autoReview), launchAtLogin: Boolean(data.launchAtLogin) };
      store.save();
    });
    bind('notification:test', () => notify('Piku 已准备好', '任务到期时，我会在这里提醒你。'));
    createWindow();
    chatgpt.refresh().catch(() => {});
    const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVQ4T2NkYGD4z0ABYBw1YNSAUQOGAwAAT/8BHeUqC8wAAAAASUVORK5CYII=');
    icon.setTemplateImage(true); tray = new Tray(icon); tray.setTitle('◒'); tray.setToolTip('Piku · 日常助手');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Piku', click: show }, { label: '立即分析待办', click: () => review().catch(e => { show(); window.webContents.send('notice', e.message); }) }, { type: 'separator' }, { label: '退出 Piku', click: () => app.quit() }]));
    tray.on('click', show);
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Piku', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    setInterval(tick, 15000); powerMonitor.on('resume', tick); tick();
  }).catch(error => { console.error('Piku 启动失败：', error.message); app.quit(); });
  app.on('activate', show);
  app.on('before-quit', () => { quitting = true; chatgpt?.stop(); });
}
