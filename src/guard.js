/**
 * The owner's guardrails: what an agent may spend, on what, and whether it may
 * send anything at all. Pure, apart from the day's ledger file.
 *
 *   MM_LIVE=1            actually send. Anything else: DRY RUN — every tool
 *                        builds, simulates and says what it would do, and
 *                        nothing is signed.
 *   MM_MAX_PER_TX        per currency, e.g. "BNB:0.05,USDT:50"  (default BNB:0.05)
 *   MM_MAX_PER_DAY       per currency, per UTC day               (default BNB:0.25)
 *   MM_ALLOW_TOKENS      comma-separated token addresses the agent may trade.
 *                        Unset: any token.
 *
 * A currency with no cap cannot be spent live. Caps are what the owner wrote
 * down, never a default we guessed for them, except the small BNB ones above.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseUnits, formatUnits } from 'ethers';

const lower = (s) => String(s ?? '').trim().toLowerCase();

/** "BNB:0.05,USDT:50" → Map(symbol → decimal string). */
export function capsFrom(text, fallback) {
  const out = new Map();
  for (const part of String(text ?? fallback ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [sym, amount] = part.split(':').map((x) => x?.trim());
    if (!sym || !amount || !(Number(amount) >= 0)) throw new Error(`Cannot read the cap "${part}": write it as SYMBOL:amount, e.g. BNB:0.05`);
    out.set(sym.toUpperCase(), amount);
  }
  return out;
}

export function limitsFrom(env = process.env) {
  const allow = String(env.MM_ALLOW_TOKENS ?? '').split(',').map(lower).filter(Boolean);
  return {
    live: env.MM_LIVE === '1',
    perTx: capsFrom(env.MM_MAX_PER_TX, 'BNB:0.05'),
    perDay: capsFrom(env.MM_MAX_PER_DAY, 'BNB:0.25'),
    allow: allow.length ? new Set(allow) : null,
  };
}

/**
 * May this spend go out? Pure.
 * @param spend     { symbol, wei (bigint), decimals }, or null for a sale (spends no money)
 * @param token     the token traded, or null for a launch
 * @param spentToday Map(symbol → bigint wei already spent today)
 * @returns { ok: true } | { ok: false, reason }
 */
export function allowed({ limits, token, spend, spentToday }) {
  if (token && limits.allow && !limits.allow.has(lower(token))) {
    return { ok: false, reason: `${token} is not on this agent's allowlist (MM_ALLOW_TOKENS).` };
  }
  if (!spend || spend.wei === 0n) return { ok: true };
  const sym = spend.symbol.toUpperCase();
  const perTx = limits.perTx.get(sym);
  const perDay = limits.perDay.get(sym);
  if (perTx === undefined || perDay === undefined) {
    return { ok: false, reason: `No spending cap is set for ${sym}, so the agent may not spend it. Add ${sym}:<amount> to MM_MAX_PER_TX and MM_MAX_PER_DAY.` };
  }
  const txCap = parseUnits(perTx, spend.decimals);
  if (spend.wei > txCap) {
    return { ok: false, reason: `This spends ${formatUnits(spend.wei, spend.decimals)} ${sym}; the cap per transaction is ${perTx} ${sym} (MM_MAX_PER_TX).` };
  }
  const used = spentToday.get(sym) ?? 0n;
  const dayCap = parseUnits(perDay, spend.decimals);
  if (used + spend.wei > dayCap) {
    return { ok: false, reason: `Today's spend would reach ${formatUnits(used + spend.wei, spend.decimals)} ${sym}; the daily cap is ${perDay} ${sym} (MM_MAX_PER_DAY). It resets at 00:00 UTC.` };
  }
  return { ok: true };
}

/* ── the day's ledger: what was spent live, per currency, kept across restarts ── */

const today = (now = new Date()) => now.toISOString().slice(0, 10);

export function ledger({ dir = process.env.MM_STATE_DIR ?? join(homedir(), '.marketmayhem-mcp'), now = () => new Date() } = {}) {
  const file = join(dir, 'spent.json');
  const read = () => {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.day !== today(now())) return new Map();
      return new Map(Object.entries(saved.spent ?? {}).map(([k, v]) => [k, BigInt(v)]));
    } catch { return new Map(); }
  };
  return {
    spentToday: read,
    add(symbol, wei) {
      const spent = read();
      const sym = symbol.toUpperCase();
      spent.set(sym, (spent.get(sym) ?? 0n) + wei);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ day: today(now()), spent: Object.fromEntries([...spent].map(([k, v]) => [k, v.toString()])) }));
    },
  };
}
