const { BrowserWindow, ipcMain, Menu, screen, nativeImage, shell, systemPreferences } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RegionCapture, CaptureSession } = require('./capture.cjs');

class CaptureWindows {
  constructor({ store, getMainWindow, showMain, isLoggedIn, recognize, publish, onLogin }) {
    Object.assign(this, { store, getMainWindow, showMain, isLoggedIn, recognize, publish, onLogin });
    this.nativeCapture = new RegionCapture(); this.session = new CaptureSession(); this.floating = null; this.preview = null;
    this.capturing = false; this.stopping = false; this.error = null; this.drag = null;
    this.floatUrl = pathToFileURL(path.join(__dirname, 'ui/floating.html')).href;
    this.quickUrl = pathToFileURL(path.join(__dirname, 'ui/quick.html')).href;
    this.quick = null;
    this.previewUrl = pathToFileURL(path.join(__dirname, 'ui/capture.html')).href;
    this.bind('capture:start', ['float', 'quick', 'preview', 'main'], () => this.start());
    this.bind('quick:toggle', ['float'], () => this.toggleQuick());
    this.bind('quick:hide', ['quick'], () => this.quick.hide());
    this.bind('quick:save', ['quick'], title => { const task = this.store.add({ title, reminderAt: null, dueAt: null }); this.publish(); return task.id; });
    this.bind('capture:get', ['preview'], () => this.state());
    this.bind('capture:recognize', ['preview'], id => this.identify(id));
    this.bind('capture:discard', ['preview'], () => this.closePreview());
    this.bind('capture:save', ['preview'], data => { const tasks = this.session.save(data.id, data.tasks, this.store); this.publish(); this.closePreview(); return tasks.length; });
    this.bind('capture:login', ['preview'], () => { this.showMain(); this.onLogin(); });
    this.bind('capture:permissions', ['preview'], () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));
    this.bind('float:drag-start', ['float'], () => { this.drag = { cursor: screen.getCursorScreenPoint(), bounds: this.floating.getBounds() }; });
    this.bind('float:drag', ['float'], () => {
      if (!this.drag) return;
      const cursor = screen.getCursorScreenPoint();
      const { bounds } = this.drag;
      this.floating.setPosition(Math.round(bounds.x + cursor.x - this.drag.cursor.x), Math.round(bounds.y + cursor.y - this.drag.cursor.y));
    });
    this.bind('float:drag-end', ['float'], () => { this.drag = null; this.clampFloat(); });
    this.bind('float:menu', ['float'], () => Menu.buildFromTemplate([{ label: '框选截图，识别待办', click: () => this.start() }, { label: '打开待办清单', click: showMain }, { type: 'separator' }, { label: '隐藏悬浮图标（可从菜单栏恢复）', click: () => this.floating.hide() }]).popup({ window: this.floating }));
    screen.on('display-removed', () => this.clampFloat());
    screen.on('display-metrics-changed', () => this.clampFloat());
  }
  bind(channel, allowed, handler) {
    ipcMain.handle(channel, async (event, data) => {
      const targets = { quick: [this.quick, this.quickUrl], float: [this.floating, this.floatUrl], preview: [this.preview, this.previewUrl], main: [this.getMainWindow(), pathToFileURL(path.join(__dirname, 'ui/index.html')).href] };
      const valid = allowed.some(key => { const [window, url] = targets[key]; return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame?.url === url; });
      if (!valid) return { ok: false, error: '来源不受信任' };
      try { return { ok: true, data: await handler(data) }; } catch (error) { return { ok: false, error: error.message }; }
    });
  }
  createWindow(url, options) {
    const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'capture-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }, ...options });
    window.loadURL(url);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
    return window;
  }
  showFloating() {
    if (this.stopping) return;
    if (!this.floating || this.floating.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea;
      this.floating = this.createWindow(this.floatUrl, { width: 64, height: 64, x: area.x + area.width - 86, y: area.y + Math.round(area.height * 0.55), frame: false, transparent: true, resizable: false, hasShadow: false, skipTaskbar: true, title: 'Piku 悬浮图标' });
      this.floating.setAlwaysOnTop(true, 'floating');
      this.floating.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.floating.once('ready-to-show', () => { if (!this.capturing && !this.stopping) this.floating.showInactive(); });
    } else if (!this.capturing) this.floating.showInactive();
  }
  toggleQuick() {
    if (this.stopping || this.capturing) return;
    if (this.quick?.isVisible()) { this.quick.hide(); return; }
    const anchor = this.floating.getBounds(), area = screen.getDisplayMatching(anchor).workArea;
    const x = Math.max(area.x, Math.min(anchor.x - 328, area.x + area.width - 384));
    const y = Math.max(area.y, Math.min(anchor.y - 12, area.y + area.height - 88));
    if (!this.quick || this.quick.isDestroyed()) {
      const quick = this.quick = this.createWindow(this.quickUrl, { width: 384, height: 88, x, y, frame: false, transparent: true, resizable: false, hasShadow: false, skipTaskbar: true, title: 'Piku · 快速记录' });
      quick.setAlwaysOnTop(true, 'floating');
      quick.once('ready-to-show', () => { if (!this.stopping && !quick.isDestroyed()) { quick.show(); quick.focus(); } });
      quick.on('blur', () => quick.hide());
      quick.on('show', () => quick.webContents.send('quick:focus'));
    } else { this.quick.setPosition(x, y); this.quick.show(); this.quick.focus(); }
  }
  clampFloat() {
    if (!this.floating || this.floating.isDestroyed()) return;
    const b = this.floating.getBounds(), area = screen.getDisplayMatching(b).workArea;
    this.floating.setPosition(Math.max(area.x, Math.min(b.x, area.x + area.width - b.width)), Math.max(area.y, Math.min(b.y, area.y + area.height - b.height)));
  }
  state() {
    const current = this.session.current;
    return { id: current?.id || null, image: current?.image.preview || null, status: current?.status || 'error', tasks: current?.tasks || [], error: current?.error || this.error, loggedIn: this.isLoggedIn() };
  }
  changed() { if (this.preview && !this.preview.isDestroyed()) this.preview.webContents.send('capture:state', this.state()); }
  showPreview() {
    if (this.stopping) return;
    if (!this.preview || this.preview.isDestroyed()) {
      this.preview = this.createWindow(this.previewUrl, { width: 420, height: 510, minWidth: 380, minHeight: 400, title: 'Piku · 截图记事', titleBarStyle: 'hiddenInset', backgroundColor: '#faf9fd' });
      const preview = this.preview;
      preview.once('ready-to-show', () => { if (!this.stopping && this.preview === preview && !preview.isDestroyed()) { preview.show(); this.changed(); } });
      preview.on('closed', () => { if (this.preview === preview) { this.preview = null; this.session.discard(); this.error = null; } });
    } else { this.preview.show(); this.preview.focus(); this.changed(); }
  }
  closePreview() { this.session.discard(); this.error = null; const preview = this.preview; this.preview = null; preview?.close(); }
  async start() {
    if (this.capturing || this.stopping) return;
    if (this.session.current?.status === 'recognizing') { this.showPreview(); return; }
    this.quick?.hide(); this.closePreview(); this.capturing = true; this.error = null;
    const main = this.getMainWindow(), restoreMain = main?.isVisible();
    main?.hide(); this.floating?.hide();
    try {
      if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) throw new Error('请允许 Piku 使用屏幕录制权限，然后重新打开 Piku 再截图');
      await new Promise(resolve => setTimeout(resolve, 180)); // Let the window compositor remove Piku before native selection begins.
      if (this.stopping) return;
      const captured = await this.nativeCapture.take();
      if (!captured || this.stopping) { captured?.cleanup(); if (restoreMain && !this.stopping) main.show(); return; }
      const image = nativeImage.createFromPath(captured.file);
      if (image.isEmpty()) { captured.cleanup(); throw new Error('没有得到有效的截图，请重新框选'); }
      const size = image.getSize();
      const preview = size.width > 900 ? image.resize({ width: 900 }) : image;
      const current = this.session.begin({ ...captured, preview: preview.toDataURL() });
      this.showPreview();
      if (this.isLoggedIn()) this.identify(current.id).catch(() => {});
    } catch (error) { if (!this.stopping) { this.error = error.message; this.showPreview(); } }
    finally { this.capturing = false; this.showFloating(); }
  }
  async identify(id) {
    if (!this.isLoggedIn()) throw new Error('请先登录 ChatGPT，再识别这张截图');
    return this.session.recognize(id, (file, signal) => this.recognize(file, signal), () => this.changed());
  }
  stop() { this.stopping = true; this.nativeCapture.cancel(); this.session.discard(); this.preview?.destroy(); this.quick?.destroy(); this.floating?.destroy(); }
}
module.exports = { CaptureWindows };
