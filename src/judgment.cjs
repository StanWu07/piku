const { randomUUID } = require('node:crypto');
const { requestAI, validateAction } = require('./core.cjs');
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: 'string' }, nullable = { type: ['string', 'null'] };
const schema = object({
  decision: { type: 'string', enum: ['agent', 'assisted', 'human'] }, reason: text, humanStep: text,
  actions: { type: 'array', maxItems: 1, items: object({ taskId: text, kind: { type: 'string', enum: ['draft', 'open_url', 'reminder'] }, title: text, reason: text, content: text, url: nullable, reminderAt: nullable }) }
});
function taskSnapshot(task) {
  return JSON.stringify({ id: task.id, title: task.title, notes: task.notes, dueAt: task.dueAt, reminderAt: task.reminderAt, status: task.status, revision: task.judgmentRevision });
}
async function judgeTask(task, options) {
  const result = await requestAI({ ...options, schema, input: `当前时间：${new Date().toISOString()}。用户时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}。
判断这件事应该由谁完成，必须依据本应用实际能力，不以通用 AI 的理论能力判断。
本应用只能：将你准备的完整文稿保存为本地 Markdown；打开用户在事项中明确提供的 HTTP/HTTPS 网页；按用户明确要求设置本机提醒。
不能操作其他应用、搜索网络、读取用户文件、发送或提交消息、购买付款、预约、代替用户学习练习或完成线下事务。
agent：事项的整个目标在上述能力内且现有信息足够。例如根据给出的材料写一份完整文稿。assisted：能准备有价值的具体部分，但最终需要用户继续完成，如写邮件草稿后由用户发送。human：必须用户亲自做，或缺少必要材料且无法准备有效成果。不要为取快递、练习、赴约等强行生成空泛文稿或提醒。
reason 简短解释。humanStep 写清用户还需做什么或提供什么，agent 时为空。human 的 actions 必须为空；其他情况恰好提供一个待用户确认的动作。draft.content 必须是可保存的完整文稿，不编造未提供的事实。打开网站或设置提醒通常不等于完成网站业务或原事项，必须分为 assisted。没有明确要求不要擅自安排提醒。
所有动作只是提案，不执行、不声称已完成。用户会先查看完整动作再授权。
待办：${taskSnapshot(task)}` });
  if (!['agent', 'assisted', 'human'].includes(result.decision) || typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 2000 || typeof result.humanStep !== 'string' || result.humanStep.length > 2000 || !Array.isArray(result.actions) || result.actions.length > 1) throw new Error('分工判断格式不正确，请重试');
  if (result.decision === 'human' && result.actions.length) throw new Error('需要本人完成的事项不应生成执行动作');
  if (result.decision !== 'human' && result.actions.length !== 1) throw new Error('助手判断缺少可确认的具体动作');
  if (result.decision === 'assisted' && !result.humanStep.trim()) throw new Error('请明确仍需用户完成的部分');
  const actions = result.actions.map(action => {
    if (action.taskId !== task.id) throw new Error('执行动作关联了其他事项');
    return validateAction(action, [task]);
  });
  return { decision: result.decision, reason: result.reason.trim(), humanStep: result.humanStep.trim(), actions };
}

// Persists proposals only; execution stays behind the existing approval IPC.
class JudgmentRunner {
  constructor({ store, generate, canRun, onChange }) { Object.assign(this, { store, generate, canRun, onChange }); this.running = false; this.stopped = false; }
  async run(id) {
    const task = this.store.state.tasks.find(t => t.id === id && t.status === 'todo');
    if (!task) throw new Error('待办不存在或已完成');
    if (task.judgment?.status === 'ready' || task.judgment?.status === 'running') return;
    if (this.stopped || this.running || !this.canRun()) throw new Error('助手正在处理其他请求，请稍后再点击判断');
    if (this.store.state.actions.some(a => a.taskId === task.id && a.status === 'executing')) throw new Error('这件事的动作正在执行，请稍后再判断');
    this.running = true;
    const snapshot = taskSnapshot(task), copy = JSON.parse(snapshot);
    const running = task.judgment = { status: 'running' }; this.store.save(); this.onChange();
    const current = () => !this.stopped && this.store.state.tasks.includes(task) && taskSnapshot(task) === snapshot;
    try {
      const result = await this.generate(copy);
      if (!current()) return;
      const actions = result.actions.map(a => ({ ...a, id: randomUUID(), status: 'pending', source: 'judgment', createdAt: new Date().toISOString() }));
      // A global review may already have prepared the same kind of proposal.
      const ids = actions.map(a => {
        const existing = this.store.state.actions.find(item => item.taskId === task.id && item.kind === a.kind && item.status === 'pending');
        if (existing) return existing.id;
        this.store.state.actions.unshift(a); return a.id;
      });
      task.judgment = { status: 'ready', decision: result.decision, reason: result.reason, humanStep: result.humanStep, actionIds: ids, at: new Date().toISOString() };
      this.store.log(`已判断事项分工：${task.title}`);
    } catch (error) { if (current()) task.judgment = { status: 'error', error: error.message }; }
    finally { this.running = false; if (!this.stopped) { if (task.judgment === running) task.judgment = null; this.store.save(); this.onChange(); } }
  }
  stop() { this.stopped = true; }
}
module.exports = { judgeTask, JudgmentRunner };
