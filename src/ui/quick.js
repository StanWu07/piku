const input = document.querySelector('#title'), status = document.querySelector('#status');
let saving = false;
async function call(channel, data) { const result = await window.pikuCapture.call(channel, data); if (!result.ok) throw new Error(result.error); return result.data; }
document.querySelector('#quick').addEventListener('submit', async event => {
  event.preventDefault(); if (saving || !input.value.trim()) return;
  saving = true; input.readOnly = true;
  try { await call('quick:save', input.value.trim()); input.value = ''; status.textContent = '已记下'; }
  catch (error) { status.textContent = error.message; }
  finally { saving = false; input.readOnly = false; input.focus(); }
});
input.addEventListener('input', () => { status.textContent = ''; });
input.addEventListener('keydown', event => { if (event.key === 'Enter' && event.isComposing) event.preventDefault(); });
document.querySelector('#screenshot').addEventListener('click', async () => { try { await call('capture:start'); } catch (error) { status.textContent = error.message; } });
document.addEventListener('keydown', event => { if (event.key === 'Escape') call('quick:hide'); });
window.pikuCapture.onFocus(() => { status.textContent = ''; input.focus(); });
window.addEventListener('focus', () => input.focus());
