// Optional host capability. Resource plugins know only this helper, not the desktop shell.
export function createLocalResourceHeaders({ enabled = false } = {}) {
  return (req, absolutePath) => {
    if (!enabled || req.method !== 'HEAD' || req.headers['x-neo-resource-action'] !== 'reveal') return {};
    const address = req.socket?.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return {};
    if (req.headers['sec-fetch-site'] === 'cross-site') return {};
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return {}; }
      catch { return {}; }
    }
    // Percent encoding keeps Unicode and control characters out of HTTP header syntax.
    return { 'X-Neo-Resource-Path': encodeURIComponent(absolutePath), Vary: 'X-Neo-Resource-Action' };
  };
}
