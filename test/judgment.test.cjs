const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/core.cjs');
const { judgeTask, JudgmentRunner } = require('../src/judgment.cjs');
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piku-judge-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new Store(dir); }
const draft = task => ({ taskId: task.id, kind: 'draft', title: '保存文稿', reason: '完整内容', content: '通知正文', url: null, reminderAt: null });
test('judgment validates capability, ownership and concrete approval payload', async () => {
  const task = { id: 'a', title: '写通知', notes: '', status: 'todo' };
  const run = result => judgeTask(task, { generate: async () => result });
  const agent = { decision: 'agent', reason: '可生成文稿', humanStep: '', actions: [draft(task)] };
  assert.equal((await run(agent)).actions[0].content, '通知正文');
  assert.equal((await run({ decision: 'human', reason: '本人完成', humanStep: '到现场', actions: [] })).decision, 'human');
  assert.equal((await run({ ...agent, decision: 'assisted', humanStep: '你需要发送文稿' })).decision, 'assisted');
  await assert.rejects(run({ ...agent, actions: [] }), /缺少/);
  await assert.rejects(run({ ...agent, decision: 'human' }), /不应/);
  await assert.rejects(run({ ...agent, decision: 'assisted' }), /用户/);
  await assert.rejects(run({ ...agent, actions: [{ ...draft(task), taskId: 'other' }] }), /其他事项/);
  await assert.rejects(run({ ...agent, actions: [{ ...draft(task), kind: 'shell' }] }), /不支持/);
});
test('manual judgment persists only pending proposal and editing invalidates judgment and consent', async t => {
  const store = setup(t), task = store.add({ title: '写通知' }); let calls = 0;
  const untouched = store.add({ title: '未点击判断的另一件事' });
  const queue = new JudgmentRunner({ store, canRun: () => true, onChange() {}, generate: async task => { calls++; return { decision: 'agent', reason: '可完成', humanStep: '', actions: [draft(task)] }; } });
  await queue.run(task.id); await queue.run(task.id);
  assert.equal(calls, 1); assert.equal(task.judgment.status, 'ready'); assert.equal(store.state.actions.length, 1);
  assert.equal(untouched.judgment, null);
  assert.equal(store.state.actions[0].status, 'pending'); assert.equal(task.status, 'todo');
  store.update(task.id, { title: '修改通知' });
  assert.equal(task.judgment, null); assert.equal(store.state.actions[0].status, 'cancelled');
});
test('late judgment is ignored after edit, completion or removal', async t => {
  for (const mutate of [(s, id) => s.update(id, { title: '新事项' }), (s, id) => s.update(id, { status: 'done' }), (s, id) => s.remove(id)]) {
    const store = setup(t), task = store.add({ title: '原事项' }); let resolve;
    const queue = new JudgmentRunner({ store, canRun: () => true, onChange() {}, generate: () => new Promise(r => { resolve = r; }) });
    const job = queue.run(task.id); mutate(store, task.id); resolve({ decision: 'agent', reason: '旧结果', humanStep: '', actions: [draft(task)] }); await job;
    assert.equal(store.state.actions.length, 0); assert.notEqual(task.judgment?.status, 'ready');
  }
});
test('offline skips classification; failure can be retried and interrupted jobs recover', async t => {
  const store = setup(t), task = store.add({ title: '事情' }); let connected = false, calls = 0;
  const queue = new JudgmentRunner({ store, canRun: () => connected, onChange() {}, generate: async () => { calls++; throw Error('暂不可用'); } });
  await assert.rejects(queue.run(task.id), /稍后/); assert.equal(calls, 0); connected = true; await queue.run(task.id);
  assert.equal(calls, 1); assert.equal(task.judgment.status, 'error');
  task.judgment = { status: 'running' }; store.save();
  assert.equal(new Store(store.directory).state.tasks[0].judgment, null);
});
