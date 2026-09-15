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

export const appUrl = value => withAppBase(value);
export const appFetch = (input, init) => globalThis.fetch(appUrl(input), init);
