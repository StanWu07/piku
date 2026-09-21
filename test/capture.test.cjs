const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RegionCapture, CaptureSession } = require('../src/capture.cjs');
const { Store, extractScreenshot } = require('../src/core.cjs');
function nativeProcess(complete) {
  return (executable, args, options) => {
    assert.equal(executable, '/usr/sbin/screencapture'); assert.deepEqual(args.slice(0, -1), ['-i', '-s', '-x', '-t', 'png']);
    assert.equal(options.shell, undefined);
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => setImmediate(() => child.emit('close', null));
    setImmediate(() => complete(child, args.at(-1))); return child;
  };
}
test('native region capture uses selection only, returns private temporary file and cleans up', async () => {
  const capture = new RegionCapture({ platform: 'darwin', spawnImpl: nativeProcess((child, file) => { fs.writeFileSync(file, 'fake image'); child.emit('close', 0); }) });
  const result = await capture.take(); assert.ok(fs.existsSync(result.file)); assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
  result.cleanup(); assert.equal(fs.existsSync(result.file), false);
});
test('Esc, timeout and permission errors never return a screenshot', async () => {
  const cancelled = new RegionCapture({ platform: 'darwin', spawnImpl: nativeProcess(child => child.emit('close', 1)) });
  assert.equal(await cancelled.take(), null);
  const timed = new RegionCapture({ platform: 'darwin', timeoutMs: 10, spawnImpl: nativeProcess(() => {}) });
  assert.equal(await timed.take(), null);
  const denied = new RegionCapture({ platform: 'darwin', spawnImpl: nativeProcess(child => { child.stderr.write('could not create image from display'); child.emit('close', 1); }) });
  await assert.rejects(denied.take(), /允许 Piku/);
});
test('screenshot recognition returns draft tasks and does not invent reminder times', async () => {
  const result = await extractScreenshot('/tmp/selected-region.png', { generate: async request => {
    assert.equal(request.imagePath, '/tmp/selected-region.png'); assert.match(request.input, /无法辨认/);
    assert.equal(request.schema.properties.tasks.maxItems, 1);
    return { tasks: [{ title: '提交报告', notes: '会议要求', dueAt: null, reminderAt: '2099-01-01T00:00:00Z' }] };
  } });
  assert.equal(result[0].reminderAt, null); assert.equal(result[0].dueAt, null);
});
test('one screenshot cannot produce or save multiple tasks', async t => {
  await assert.rejects(extractScreenshot('/tmp/region.png', { generate: async () => ({ tasks: [{ title: '步骤一' }, { title: '步骤二' }] }) }), /一张截图/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'piku-single-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory), session = new CaptureSession();
  const current = session.begin({ file: '/tmp/region.png', cleanup() {} });
  assert.throws(() => session.save(current.id, [{ title: '步骤一' }, { title: '步骤二' }], store), /一张截图/);
  assert.equal(store.state.tasks.length, 0);
  session.save(current.id, [{ title: '完成今日作业', notes: '语文：阅读课文\n数学：完成练习', dueAt: null }], store);
  assert.equal(store.state.tasks.length, 1);
  assert.match(store.state.tasks[0].notes, /语文.*\n数学/);
});
test('capture sessions require confirmation, reject duplicate saves, and validate all edits before adding', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'piku-session-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory), session = new CaptureSession(); let cleaned = false;
  const current = session.begin({ file: '/tmp/region.png', cleanup: () => { cleaned = true; } });
  await session.recognize(current.id, async () => [{ title: '识别到的事', dueAt: null }], () => {});
  assert.equal(store.state.tasks.length, 0);
  assert.throws(() => session.save(current.id, [{ title: 'ok' }, { title: '' }], store)); assert.equal(store.state.tasks.length, 0);
  session.save(current.id, [{ title: '用户修改后的事', dueAt: null }], store);
  assert.equal(store.state.tasks[0].title, '用户修改后的事'); assert.equal(cleaned, true);
  assert.throws(() => session.save(current.id, [{ title: 'duplicate' }], store)); assert.equal(store.state.tasks.length, 1);
});
test('discarding while recognition is in flight aborts it and ignores late results', async () => {
  const session = new CaptureSession(); let finish, aborted = false, cleaned = false;
  const current = session.begin({ file: '/tmp/region.png', cleanup: () => { cleaned = true; } });
  const job = session.recognize(current.id, (_file, signal) => new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => { aborted = true; }); }), () => {});
  session.discard(); assert.equal(aborted, true); finish([{ title: 'late' }]); await job;
  assert.equal(session.current, null); assert.equal(cleaned, true);
});
