const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, safeUrl, execute, dueReminders, requestAI, analyze, extract } = require('../src/core.cjs');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piku-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new Store(dir); }
function proposal(store, task, fields = {}) { const action = { id: 'action-1', taskId: task.id, kind: 'draft', title: '汇报草稿', reason: '准备汇报', content: '本周完成…', status: 'pending', ...fields }; store.state.actions.push(action); store.save(); return action; }
function mockAI(result) { return async request => { assert.ok(request.schema); assert.ok(request.instructions); return result; }; }
test('tasks persist, edit invalidates stale approvals, completion suppresses reminders', t => {
  const store = fixture(t); const task = store.add({ title: '买牛奶', reminderAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(dueReminders(store).length, 1); const action = proposal(store, task);
  store.update(task.id, { status: 'done' }); assert.equal(action.status, 'cancelled'); assert.equal(dueReminders(store).length, 0);
  assert.equal(new Store(store.directory).state.tasks[0].status, 'done');
});
test('approved execution is durable and rejects concurrent or repeated clicks', async t => {
  const store = fixture(t); const task = store.add({ title: '准备汇报' }); const action = proposal(store, task); let calls = 0;
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const first = execute(store, action.id, { writeDraft: async () => { calls++; await pending; return '/draft.md'; } });
  await assert.rejects(execute(store, action.id, {}), /不能重复/); finish(); await first;
  await assert.rejects(execute(store, action.id, {}), /不能重复/); assert.equal(calls, 1); assert.equal(task.status, 'todo');
  assert.equal(new Store(store.directory).state.actions[0].status, 'done');
});
test('unsafe or invented URLs cannot reach OS adapter', async t => {
  const store = fixture(t); const task = store.add({ title: '查看资料', notes: 'https://example.com/doc' });
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://other.example']) {
    store.state.actions = []; const action = proposal(store, task, { kind: 'open_url', url });
    await assert.rejects(execute(store, action.id, { openUrl: () => assert.fail('must not execute') }));
  }
  assert.equal(safeUrl('https://example.com/doc'), 'https://example.com/doc');
});
test('reminders execute only after approval and reset delivered state', async t => {
  const store = fixture(t); const task = store.add({ title: '喝水' });
  const reminderAt = new Date(Date.now() + 60000).toISOString(); const action = proposal(store, task, { kind: 'reminder', reminderAt });
  assert.equal(task.reminderAt, null); await execute(store, action.id, {}); assert.equal(task.reminderAt, reminderAt);
  assert.equal(dueReminders(store).length, 0); assert.equal(dueReminders(store, Date.now() + 120000).length, 1);
  task.notifiedAt = new Date().toISOString(); assert.equal(dueReminders(store, Date.now() + 120000).length, 0);
});
test('interrupted execution is not automatically replayed; failures are recorded', async t => {
  const store = fixture(t); const task = store.add({ title: '写草稿' }); const action = proposal(store, task);
  await execute(store, action.id, { writeDraft: async () => { throw new Error('磁盘已满'); } });
  assert.equal(action.status, 'failed'); assert.equal(action.error, '磁盘已满');
  action.status = 'executing'; store.save(); const restored = new Store(store.directory); assert.equal(restored.state.actions[0].status, 'uncertain');
});
test('ChatGPT adapter extracts and analyzes structured results with injected transport', async t => {
  const store = fixture(t); const task = store.add({ title: '准备汇报' });
  const options = { model: 'test-model' };
  const extracted = await extract('准备汇报', { ...options, generate: mockAI({ tasks: [{ title: '准备汇报', notes: '', dueAt: null, reminderAt: null, priority: 'high', category: 'work' }] }) });
  assert.equal(extracted[0].title, task.title);
  const result = await analyze([task], { ...options, generate: mockAI({ summary: '先准备汇报', focus: [{ taskId: task.id, reason: '重要', nextStep: '整理本周进度', priority: 'high' }], actions: [] }) });
  assert.equal(result.focus[0].taskId, task.id);
});
test('missing ChatGPT adapter is rejected', async () => {
  await assert.rejects(requestAI({ model: '' }), /ChatGPT/);
});
test('old API configuration migrates without losing tasks', t => {
  const store = fixture(t); store.add({ title: 'keep me' });
  store.state.settings = { model: 'old-api-model', autoReview: true, launchAtLogin: true }; store.save();
  const restored = new Store(store.directory);
  assert.equal(restored.state.settings.authMode, 'chatgpt');
  assert.equal(restored.state.settings.model, '');
  assert.equal(restored.state.settings.autoReview, false);
  assert.equal(restored.state.tasks[0].title, 'keep me');
});
