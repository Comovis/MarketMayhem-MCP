/**
 * The MCP server: Market Mayhem's API as tools an agent can call.
 *
 * Every tool that moves money goes through the same three steps:
 *   1. build it with the API (simulated on chain; a trade that would revert
 *      comes back as an error with the reason, never as a transaction);
 *   2. check it against the owner's guardrails (guard.js);
 *   3. DRY RUN (the default): say exactly what would be sent, and stop.
 *      LIVE (MM_LIVE=1): send any one-time approvals, rebuild, sign and send,
 *      and record what was spent against today's caps.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatUnits } from 'ethers';
import { api as makeApi, MayhemError } from './api.js';
import { agentWallet } from './wallet.js';
import { allowed, ledger as makeLedger, limitsFrom } from './guard.js';

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x address');
const AMOUNT = z.string().regex(/^\d+(\.\d+)?$/, 'a decimal amount, e.g. "0.05"');

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = (err) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify(err instanceof MayhemError
    ? { error: err.code, message: err.message, fix: err.fix, detail: err.detail }
    : { error: 'FAILED', message: err.message }, null, 2) }],
});
const run = (fn) => async (args) => { try { return text(await fn(args ?? {})); } catch (err) { return failure(err); } };

/**
 * @param deps  injected for tests: { api, wallet, limits, ledger }
 */
export async function createServer(deps = {}) {
  const api = deps.api ?? makeApi();
  const limits = deps.limits ?? limitsFrom();
  const ledger = deps.ledger ?? makeLedger();
  let settingsCache = null;
  const settings = async () => (settingsCache ??= await api.settings());
  const walletFor = async () => {
    if (deps.wallet !== undefined) return deps.wallet;
    return agentWallet({ chainId: (await settings()).chainId });
  };
  const needWallet = async () => {
    const w = await walletFor();
    if (!w) throw new Error('No wallet: set MM_PRIVATE_KEY to the agent\'s own wallet key (or MM_WALLET to an address, for dry runs only). Quotes and token reads work without either.');
    return w;
  };

  /** Guardrails, then dry run or send. `build(wallet)` is called again after approvals are mined. */
  const execute = async ({ kind, token, build, spendOf }) => {
    const w = await needWallet();
    let built = await build(w.address);
    const spend = spendOf(built);
    const verdict = allowed({ limits, token, spend, spentToday: ledger.spentToday() });
    const spendText = spend && spend.wei > 0n ? `${formatUnits(spend.wei, spend.decimals)} ${spend.symbol}` : 'nothing';
    if (!verdict.ok) return { sent: false, refused: verdict.reason, wouldDo: built.explain };
    if (!limits.live) {
      return {
        sent: false, dryRun: true,
        wouldDo: built.explain, spends: spendText,
        steps: [...(built.requires ?? []).map((r) => r.explain), `the ${kind} itself`],
        note: 'Dry run: nothing was signed. The owner sets MM_LIVE=1 to let this agent send.',
      };
    }
    const hashes = [];
    for (let round = 0; round < 3 && built.requires?.length; round += 1) {
      for (const step of built.requires) hashes.push(await w.send(step.tx));
      built = await build(w.address);                 // rebuilt now that approvals are mined: simulated for real
    }
    if (built.requires?.length) throw new Error('The wallet still needs an approval after three attempts; nothing more was sent.');
    const hash = await w.send(built.tx);
    hashes.push(hash);
    if (spend && spend.wei > 0n) ledger.add(spend.symbol, spend.wei);
    let status = null;
    try { status = await api.tx(hash); } catch { /* the chain has it; the index may lag */ }
    return { sent: true, did: built.explain, spent: spendText, tx: hash, allTransactions: hashes, status };
  };

  const server = new McpServer({
    name: 'marketmayhem',
    title: 'Market Mayhem',
    version: '0.1.1',
    description: 'Launch and trade tokens on BNB Chain with your own wallet: dry run by default, within caps you set.',
    websiteUrl: 'https://marketmayhem.co/developers/',
    icons: [
      { src: 'https://marketmayhem.co/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
      { src: 'https://marketmayhem.co/icon-192.png', mimeType: 'image/png', sizes: ['192x192'] },
    ],
  });

  server.registerTool('get_settings', {
    description: 'The live network, contracts, fees and pair currencies Market Mayhem uses. Read this first.',
    inputSchema: {},
  }, run(async () => ({ ...(await settings()), agent: { live: limits.live, wallet: (await walletFor())?.address ?? null } })));

  server.registerTool('new_launches', {
    description: 'Tokens launched on Market Mayhem, newest first. Pass `after` (a block from the previous answer\'s `next`) to get only what launched since.',
    inputSchema: { after: z.number().int().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, run((a) => api.launches(a)));

  server.registerTool('get_token', {
    description: 'One token: its symbol, name, pool, fee tier, pair currency and creator. Use quote for a price.',
    inputSchema: { token: ADDRESS },
  }, run((a) => api.token(a.token)));

  server.registerTool('quote', {
    description: 'What a buy or a sell would get right now, with the price impact and the site fee. Sends nothing.',
    inputSchema: { token: ADDRESS, side: z.enum(['buy', 'sell']), amount: AMOUNT.describe('buy: the pair currency to spend; sell: whole tokens to sell'), slippageBps: z.number().int().min(1).max(5000).optional() },
  }, run((a) => api.quote(a)));

  server.registerTool('buy', {
    description: 'Buy a token with its pair currency (BNB for most). DRY RUN unless the owner set MM_LIVE=1; always within the owner\'s caps and allowlist.',
    inputSchema: { token: ADDRESS, amount: AMOUNT.describe('how much of the pair currency to spend'), slippageBps: z.number().int().min(1).max(5000).optional(), referrer: ADDRESS.optional() },
  }, run((a) => execute({
    kind: 'buy', token: a.token,
    build: (wallet) => api.buildBuy({ wallet, token: a.token, amount: a.amount, slippageBps: a.slippageBps, ...(a.referrer ? { referrer: a.referrer } : {}) }),
    spendOf: (b) => ({ symbol: b.pay.symbol, wei: BigInt(b.limit?.kind === 'maxPay' ? b.limit.wei : b.pay.wei), decimals: b.token.pair.decimals }),
  })));

  server.registerTool('sell', {
    description: 'Sell a token for its pair currency. Give `amount` (whole tokens) or `percent` of what the wallet holds. DRY RUN unless MM_LIVE=1.',
    inputSchema: { token: ADDRESS, amount: AMOUNT.optional(), percent: z.number().min(0.01).max(100).optional(), slippageBps: z.number().int().min(1).max(5000).optional() },
  }, run(async (a) => {
    if ((a.amount === undefined) === (a.percent === undefined)) throw new Error('Give exactly one of amount (whole tokens) or percent.');
    let amount = a.amount;
    if (a.percent !== undefined) {
      const w = await needWallet();
      const { raw, decimals } = await w.balanceOf(a.token);
      const part = (raw * BigInt(Math.round(a.percent * 100))) / 10_000n;
      if (part === 0n) throw new Error('The wallet holds none of this token.');
      amount = formatUnits(part, decimals);
    }
    return execute({
      kind: 'sell', token: a.token,
      build: (wallet) => api.buildSell({ wallet, token: a.token, amount, slippageBps: a.slippageBps }),
      spendOf: () => null,                           // a sale spends no money; the allowlist still applies
    });
  }));

  server.registerTool('launch_token', {
    description: 'Launch a new token on Market Mayhem (a PancakeSwap V3 pool, liquidity locked for ever). Optional first buy in the same transaction, split across up to 8 wallets (e.g. the dead address to burn). DRY RUN unless MM_LIVE=1.',
    inputSchema: {
      name: z.string().min(1).max(64), symbol: z.string().min(1).max(32),
      marketCapUsd: AMOUNT.describe('the opening market cap in dollars'),
      firstBuy: AMOUNT.optional().describe('a first buy in the pair currency, in the launch transaction'),
      firstBuyTo: z.array(z.object({ wallet: ADDRESS, pct: z.number().positive() })).max(8).optional(),
      image: z.string().url().optional().describe('an https:// link to the logo'),
      description: z.string().max(1000).optional(), website: z.string().url().optional(), x: z.string().url().optional(), telegram: z.string().url().optional(),
      burnPct: z.number().min(0).max(100).optional().describe('share of the creator royalty that buys back and burns the token, for ever (100 = all)'),
      pair: z.string().optional().describe('"BNB" (default) or a pair-currency symbol or address'),
    },
  }, run(async (a) => execute({
      kind: 'launch', token: null,
      build: (wallet) => api.buildLaunch({ ...a, wallet }),
      spendOf: (b) => {
        // The first buy in the pair currency, plus any launch fee in BNB counted when the pair is BNB.
        const decimals = b.pair?.decimals ?? 18;
        const first = b.firstBuy ? BigInt(b.firstBuy.spend.wei) : 0n;
        const fee = BigInt(b.launchFee?.wei ?? 0);
        const isBnb = (b.pair?.symbol ?? 'BNB').toUpperCase() === 'BNB';
        return { symbol: b.pair?.symbol ?? 'BNB', wei: first + (isBnb ? fee : 0n), decimals };
      },
    })));

  server.registerTool('tx_status', {
    description: 'Where a transaction is: pending, mined, or indexed (visible on the site and in the API).',
    inputSchema: { hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) },
  }, run((a) => api.tx(a.hash)));

  server.registerTool('my_referral_earnings', {
    description: 'What a wallet has earned as a referrer: paid inside trades, and the lifetime weekly share. Defaults to the agent\'s wallet.',
    inputSchema: { address: ADDRESS.optional() },
  }, run(async (a) => api.referrals(a.address ?? (await needWallet()).address)));

  server.registerTool('referral_link', {
    description: 'A referral link for a wallet: anyone who trades through it pays that wallet a share of the fee, for life. Defaults to the agent\'s wallet.',
    inputSchema: { address: ADDRESS.optional(), path: z.string().optional().describe('a page on the site, e.g. /t/<token>') },
  }, run(async (a) => api.referralLink(a.address ?? (await needWallet()).address, a.path)));

  return server;
}
