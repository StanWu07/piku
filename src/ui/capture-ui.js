let current, renderedId, renderedTasks, manualId;
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const localDate = value => { if (!value) return ''; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
async function call(channel, data) { const result = await window.pikuCapture.call(channel, data); if (!result.ok) throw new Error(result.error); return result.data; }
function render(next) {
  current = next;
  $('#preview').hidden = !next.image; if (next.image) $('#preview').src = next.image; else $('#preview').removeAttribute('src');
  $('#error').hidden = !next.error; $('#error').textContent = next.error || '';
  const busy = next.status === 'recognizing';
  $('#status').classList.toggle('pending', busy);
  $('#status').textContent = busy ? 'GPT 正在识别截图中的事项…' : !next.image ? '拖动鼠标选择一个区域，按 Esc 可取消。' : !next.loggedIn ? '截图已准备好。登录 ChatGPT 后即可识别。' : next.status === 'review' ? (next.tasks.length ? '已整理为一条待办，确认标题和具体内容后保存。' : '没有识别到明确事项，你可以重新截图，或自己写一句。') : '可以重试识别，或直接写下这件事。';
  $('#controls').innerHTML = busy ? '<button class="secondary" data-action="discard">取消</button>' : `${next.image && !next.loggedIn ? '<button class="primary" data-action="login">登录 ChatGPT</button>' : ''}${next.image && next.loggedIn ? '<button class="secondary" data-action="recognize">重新识别</button>' : ''}<button class="secondary" data-action="retake">重新截图</button>${next.image ? '<button class="secondary" data-action="manual">自己写一句</button>' : '<button class="secondary" data-action="permissions">打开权限设置</button>'}`;
  $('#tasks').hidden = busy || (manualId !== next.id && (next.status !== 'review' || !next.tasks.length));
  if (next.status === 'review' && manualId !== next.id && (renderedId !== next.id || renderedTasks !== JSON.stringify(next.tasks))) {
    renderedId = next.id; renderedTasks = JSON.stringify(next.tasks); rows(next.tasks);
  }
}
function rows(tasks) {
  $('#rows').innerHTML = tasks.map((task, index) => `<div class="task" data-index="${index}"><div class="task-title"><input type="text" maxlength="200" aria-label="事项 ${index + 1}" value="${escape(task.title)}" placeholder="要做什么？"></div><details class="capture-notes"><summary>具体内容</summary><textarea aria-label="具体内容 ${index + 1}" maxlength="12000" placeholder="补充细节…">${escape(task.notes)}</textarea></details><details class="deadline" ${task.dueAt ? 'open' : ''}><summary>截止时间（选填）</summary><input type="datetime-local" aria-label="截止时间 ${index + 1}" value="${localDate(task.dueAt)}"></details></div>`).join('');
  $('#tasks').hidden = false; $('#tasks').notes = tasks.map(task => task.notes || '');
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return; button.disabled = true;
  try {
    const action = button.dataset.action;
    if (action === 'discard') await call('capture:discard');
    if (action === 'retake') await call('capture:start');
    if (action === 'recognize') { manualId = null; renderedTasks = null; await call('capture:recognize', current.id); }
    if (action === 'login') await call('capture:login');
    if (action === 'permissions') await call('capture:permissions');
    if (action === 'manual') { manualId = current.id; rows([{ title: '', notes: '', dueAt: null }]); }
  } catch (error) { $('#toast').textContent = error.message; } finally { if (button.isConnected) button.disabled = false; }
});
$('#tasks').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('[type=submit]'); if (button.disabled) return; button.disabled = true;
  try {
    const tasks = [...document.querySelectorAll('.task')].map(row => ({ title: row.querySelector('[type=text]').value, notes: row.querySelector('textarea').value, dueAt: row.querySelector('[type=datetime-local]').value ? new Date(row.querySelector('[type=datetime-local]').value).toISOString() : null }));
    await call('capture:save', { id: current.id, tasks });
  } catch (error) { $('#toast').textContent = error.message; button.disabled = false; }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') call('capture:discard').catch(() => {}); });
window.pikuCapture.onState(render);
call('capture:get').then(render).catch(error => { $('#toast').textContent = error.message; });
