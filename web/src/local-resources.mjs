// Optional desktop adapter: no plugin IDs, resource routes or storage formats.
export function isDesktop(scope = globalThis.window) {
  return typeof scope?.__TAURI__?.core?.invoke === 'function';
}

export function resourceActionTitle(label, scope = globalThis.window) {
  return isDesktop(scope) ? `打开所在文件夹：${label || '资源'}` : `下载 ${label || '资源'}`;
}

export async function openExternalLink(href, scope = globalThis.window) {
  if (!isDesktop(scope)) return false;
  const url = new URL(href);
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持此链接类型');
  await scope.__TAURI__.core.invoke('plugin:local-resources|open_external', { url: url.href });
  return true;
}
// Desktop resource actions always reveal the original file, never launch its contents.
export function openResource(href, options = {}) { return revealResource(href, options); }
export async function revealResource(href, { scope = globalThis.window, fetch = globalThis.fetch } = {}) {
  if (!isDesktop(scope)) return false;
  const url = new URL(href, scope.location.origin);
  if (url.origin !== scope.location.origin || url.username || url.password) {
    throw new Error('不能定位其他站点的本地文件');
  }
  const response = await fetch(url.href, {
    method: 'HEAD', headers: { 'X-Neo-Resource-Action': 'reveal' },
    credentials: 'same-origin', redirect: 'error', cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(response.status === 404 || response.status === 410
      ? '资源不可用：原文件已移动、删除，或对应插件未启用'
      : `无法定位文件（${response.status}）`);
  }
  const encodedPath = response.headers.get('X-Neo-Resource-Path');
  if (!encodedPath) throw new Error('此资源未提供本地文件定位能力；请确认桌面端和运行时均已更新');
  let path;
  try { path = decodeURIComponent(encodedPath); }
  catch { throw new Error('资源返回的本地路径无效'); }
  if (!path || path.includes('\0')) throw new Error('资源返回的本地路径无效');
  await scope.__TAURI__.core.invoke('plugin:local-resources|reveal_file', { path });
  return true;
}
