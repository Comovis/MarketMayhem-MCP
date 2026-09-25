/**
 * The Market Mayhem API (/api/v1), as the tools use it. Every error comes back
 * as the API sends it — a stable code, a sentence and the fix — because that is
 * what lets an agent recover on its own.
 */
export class MayhemError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.message ?? `The API answered ${status}.`);
    this.status = status;
    this.code = e.code ?? `HTTP_${status}`;
    this.fix = e.fix ?? null;
    this.detail = e.detail ?? null;
  }
}

export function api({ base = process.env.MM_API_URL ?? 'https://marketmayhem.co/api/v1', key = process.env.MM_API_KEY ?? null, fetchImpl = fetch } = {}) {
  const root = base.replace(/\/+$/, '');
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        'x-mm-client': 'marketmayhem-mcp/0.1',
        ...(key ? { 'x-api-key': key } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* an empty or non-JSON body */ }
    if (!res.ok) throw new MayhemError(res.status, json);
    return json;
  };
  const q = (params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
    return s.size ? `?${s}` : '';
  };
  return {
    settings: () => call('GET', '/settings'),
    launches: ({ after, limit } = {}) => call('GET', `/launches${q({ after, limit })}`),
    token: (address) => call('GET', `/tokens/${address}`),
    quote: ({ token, side, amount, slippageBps }) => call('GET', `/quote${q({ token, side, amount, slippageBps })}`),
    buildBuy: (body) => call('POST', '/build/buy', body),
    buildSell: (body) => call('POST', '/build/sell', body),
    buildLaunch: (body) => call('POST', '/build/launch', body),
    tx: (hash) => call('GET', `/tx/${hash}`),
    referrals: (address) => call('GET', `/referrals/${address}`),
    referralLink: (address, path) => call('GET', `/referrals/${address}/link${q({ path })}`),
  };
}
