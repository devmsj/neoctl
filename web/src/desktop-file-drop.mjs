import { isDesktop } from './local-resources.mjs';

// Physical webview coordinates -> CSS viewport coordinates, including DPI and page zoom.
export function dropHitsTarget(position, target, scope = globalThis.window) {
  const scale = Number(scope?.devicePixelRatio) || 1;
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || scale <= 0 || !target) return false;
  const x = position.x / scale, y = position.y / scale;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return false;
  // Do not drop through dialogs or overlays covering the composer.
  const hit = scope.document.elementFromPoint(x, y);
  return !!hit && target.contains(hit);
}

// Optional, generic desktop transport; no business-plugin or upload dependencies.
// Returns synchronous cleanup even while native registration is still pending.
export function connectDesktopFileDrops({ getTarget, onHover, onFiles, onError, scope = globalThis.window }) {
  if (!isDesktop(scope)) return () => {};
  const core = scope.__TAURI__.core;
  if (typeof core.Channel !== 'function') {
    onError(new Error('请更新桌面端后重试'));
    return () => {};
  }
  let disposed = false;
  const pending = new Set();
  const channel = new core.Channel();
  channel.onmessage = async (event) => {
    if (disposed) return;
    const hit = event.type !== 'leave' && dropHitsTarget(event.position, getTarget(), scope);
    onHover(event.type === 'over' && hit);
    if (event.type !== 'drop' || !hit || pending.has(event.id)) return;
    if (event.error) { onError(new Error(event.error)); return; }
    pending.add(event.id);
    try {
      const files = await core.invoke('plugin:local-resources|take_file_drop', { id: event.id });
      if (!disposed && files.length) onFiles(files);
    } catch (error) {
      if (!disposed) onError(error);
    } finally {
      pending.delete(event.id);
    }
  };
  const registration = Promise.resolve().then(() => core.invoke('plugin:local-resources|watch_file_drops', { channel }));
  registration.catch(() => {
    if (!disposed) onError(new Error('拖拽不可用，请更新桌面端后重试'));
  });
  return () => {
    if (disposed) return;
    disposed = true;
    channel.onmessage = () => {};
    onHover(false);
    registration.then(() => core.invoke('plugin:local-resources|unwatch_file_drops', { channelId: channel.id })).catch(() => {});
  };
}
