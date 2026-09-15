import { authState, isIsolationAdmin } from './auth-state.mjs';

export function withAppBase(value, base = import.meta.env?.BASE_URL || '/', origin = globalThis.location?.origin || 'http://localhost') {
  if (typeof value !== 'string' && !(value instanceof URL)) return value;
  const raw = String(value);
  if (!raw.startsWith('/') && !/^https?:\/\//i.test(raw)) return value;
  const target = new URL(raw, origin);
  if (target.origin !== origin || !/^\/(api(?:\/|$)|events(?:\/|$)|vendor(?:\/|$))/.test(target.pathname)) return value;
  const prefix = `/${base.split('/').filter(Boolean).join('/')}`;
  if (prefix === '/') return value;
  target.pathname = prefix + target.pathname;
  return `${target.pathname}${target.search}${target.hash}`;
}

export const appUrl = value => withAppBase(withAdminOwner(value));
function withAdminOwner(value) {
  if (!isIsolationAdmin() || !authState.adminOwnerUsername || (typeof value !== 'string' && !(value instanceof URL))) return value;
  const origin = globalThis.location?.origin || 'http://localhost';
  const target = new URL(String(value), origin);
  if (target.origin !== origin || !/^\/(api(?:\/|$)|events(?:\/|$))/.test(target.pathname) || /^\/api\/(auth|admin|login|memory|cpa-quota|cpa-config|prompt-config|plugins|tools)(?:\/|$)/.test(target.pathname)) return value;
  target.searchParams.set('ownerUsername', authState.adminOwnerUsername);
  return `${target.pathname}${target.search}${target.hash}`;
}
export const appFetch = async (input, init) => {
  const response = await globalThis.fetch(appUrl(input), init);
  if (response.status === 401 && !String(input).includes('/api/auth/')) {
    globalThis.dispatchEvent?.(new Event('neo-auth-required'));
  }
  return response;
};
