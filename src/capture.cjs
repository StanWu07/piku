const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { taskInput } = require('./core.cjs');

// A native, user-selected region only. Never take a whole-screen image before selection.
class RegionCapture {
  constructor({ spawnImpl = spawn, platform = process.platform, timeoutMs = 120000 } = {}) { this.spawnImpl = spawnImpl; this.platform = platform; this.timeoutMs = timeoutMs; this.child = null; }
  async take() {
    if (this.child) throw new Error('正在框选截图，按 Esc 可取消');
    if (this.platform !== 'darwin') throw new Error('当前截图入口支持 macOS');
    this.cancelled = false;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'piku-region-'));
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'region.png');
    const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
    try {
      const outcome = await new Promise((resolve, reject) => {
        const child = this.spawnImpl('/usr/sbin/screencapture', ['-i', '-s', '-x', '-t', 'png', file], { stdio: ['ignore', 'ignore', 'pipe'] });
        this.child = child; let diagnostic = '', expired = false;
        child.stderr.on('data', data => { if (diagnostic.length < 4096) diagnostic += data.toString(); });
        const timer = setTimeout(() => { expired = true; child.kill(); }, this.timeoutMs);
        child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动系统截图，请重新尝试')); });
        child.once('close', code => { clearTimeout(timer); resolve({ code, diagnostic, expired }); });
      });
      if (outcome.expired || this.cancelled) { cleanup(); return null; }
      if (!fs.existsSync(file)) {
        if (/denied|not permitted|could not create image|screen capture failed/i.test(outcome.diagnostic)) throw new Error('请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 Piku 截图，然后重新打开 Piku');
        // Esc and Control-to-clipboard yield no file. Neither sends anything to GPT.
        if (outcome.code === 0 || outcome.code === 1) { cleanup(); return null; }
        throw new Error('截图未完成，请检查系统屏幕录制权限后重试');
      }
      if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('截图区域太大，请重新选择更小的区域');
      fs.chmodSync(file, 0o600);
      return { file, cleanup };
    } catch (error) { cleanup(); throw error; } finally { this.child = null; }
  }
  cancel() { this.cancelled = true; this.child?.kill(); }
}

class CaptureSession {
  constructor() { this.current = null; }
  begin(image) {
    this.discard();
    this.current = { id: randomUUID(), image, status: 'ready', error: null, tasks: [], controller: null };
    return this.current;
  }
  require(id) {
    if (!this.current || this.current.id !== id) throw new Error('这张截图已关闭或被替换，请重新截图');
    return this.current;
  }
  async recognize(id, recognize, onChange) {
    const current = this.require(id);
    if (current.status === 'recognizing') throw new Error('正在识别，请稍候');
    current.controller = new AbortController(); current.status = 'recognizing'; current.error = null; onChange();
    try {
      const tasks = await recognize(current.image.file, current.controller.signal);
      if (this.current !== current) return;
      current.tasks = tasks; current.status = 'review';
    } catch (error) {
      if (this.current !== current) return;
      current.error = error.message; current.status = 'error';
    } finally {
      current.controller = null;
      if (this.current !== current) current.image.cleanup();
      else onChange();
    }
  }
  save(id, inputs, store) {
    const current = this.require(id);
    if (!['review', 'error', 'ready'].includes(current.status)) throw new Error('请等待识别完成');
    if (!Array.isArray(inputs) || inputs.length !== 1) throw new Error('一张截图只保存一条待办');
    // Validate every row before adding any. New captures are ordinary todos, without extra reminders.
    const tasks = inputs.map(input => taskInput({ title: input.title, notes: input.notes || '', dueAt: input.dueAt || null, reminderAt: null }));
    const previous = structuredClone(store.state);
    try {
      const result = tasks.map(task => store.add(task));
      this.discard(); return result;
    } catch (error) { store.state = previous; store.save(); throw error; }
  }
  discard() {
    const current = this.current; this.current = null;
    if (current?.controller) current.controller.abort(); else current?.image.cleanup();
  }
}
module.exports = { RegionCapture, CaptureSession };
