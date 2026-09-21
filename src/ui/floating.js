const button = document.querySelector('#capture');
let origin = null, moved = false;
button.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  origin = { x: event.screenX, y: event.screenY }; moved = false;
  button.setPointerCapture(event.pointerId); window.pikuCapture.call('float:drag-start');
});
button.addEventListener('pointermove', event => {
  if (!origin) return;
  if (Math.hypot(event.screenX - origin.x, event.screenY - origin.y) > 5) moved = true;
  if (moved) window.pikuCapture.call('float:drag', { x: event.screenX, y: event.screenY });
});
button.addEventListener('pointerup', () => {
  if (!origin) return;
  origin = null; window.pikuCapture.call('float:drag-end');
  if (!moved) window.pikuCapture.call('quick:toggle');
});
button.addEventListener('pointercancel', () => { origin = null; window.pikuCapture.call('float:drag-end'); });
button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); window.pikuCapture.call('quick:toggle'); } });
button.addEventListener('contextmenu', event => { event.preventDefault(); window.pikuCapture.call('float:menu'); });
