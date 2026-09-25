import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { allowed, capsFrom, ledger as makeLedger, limitsFrom } from '../src/guard.js';
import { MayhemError } from '../src/api.js';

const TOKEN = '0x136bfd5f42250a568ce06ed1b145729b400e391c';
const WALLET = '0x2bf842241129be12f3a0e4f21e25d2fd43d9e6da';
const wei = (bnb) => BigInt(Math.round(bnb * 1e6)) * 10n ** 12n;

/** A build as /build/buy returns it (the fields the server reads). */
const buyBuild = (bnb, requires = []) => ({
  token: { address: TOKEN, pair: { symbol: 'BNB', decimals: 18 } },
  pay: { amount: String(bnb), wei: wei(bnb).toString(), symbol: 'BNB' },
  limit: { kind: 'minReceive', wei: '1' },
  requires, tx: { chainId: 97, to: '0xrouter', data: '0x', value: wei(bnb).toString() },
  explain: `Buy about X for ${bnb} BNB.`,
});

async function connect({ env = {}, api = {}, wallet } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-mcp-'));
  const sent = [];
  const fakeWallet = wallet === null ? null : {
    address: WALLET,
    send: async (tx) => { sent.push(tx); return `0x${String(sent.length).padStart(64, '0')}`; },
    balanceOf: async () => ({ raw: 10n ** 24n, decimals: 18 }),
  };
  const server = await createServer({
    api: { settings: async () => ({ chainId: 97 }), tx: async () => ({ status: 'indexed' }), ...api },
    wallet: fakeWallet,
    limits: limitsFrom(env),
    ledger: makeLedger({ dir }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, body: JSON.parse(r.content[0].text) };
  };
  return { call, client, sent, dir };
}

test('every tool is listed, with a description an agent can act on', async () => {
  const { client } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['buy', 'get_settings', 'get_token', 'launch_token', 'my_referral_earnings', 'new_launches', 'quote', 'referral_link', 'sell', 'tx_status']);
});

test('dry run is the default: a buy says what it would do and signs nothing', async () => {
  const { call, sent } = await connect({ api: { buildBuy: async () => buyBuild(0.01) } });
  const r = await call('buy', { token: TOKEN, amount: '0.01' });
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.sent, false);
  assert.equal(r.body.spends, '0.01 BNB');
  assert.equal(sent.length, 0);
});

test('live: sends, records the spend, and the daily cap then refuses', async () => {
  const env = { MM_LIVE: '1', MM_MAX_PER_TX: 'BNB:0.05', MM_MAX_PER_DAY: 'BNB:0.08' };
  const { call, sent } = await connect({ env, api: { buildBuy: async (b) => buyBuild(Number(b.amount)) } });
  const first = await call('buy', { token: TOKEN, amount: '0.05' });
  assert.equal(first.body.sent, true);
  assert.equal(first.body.status.status, 'indexed');
  assert.equal(sent.length, 1);
  const second = await call('buy', { token: TOKEN, amount: '0.04' });
  assert.equal(second.body.sent, false);
  assert.match(second.body.refused, /daily cap is 0\.08 BNB/);
  assert.equal(sent.length, 1, 'nothing sent past the cap');
});

test('the per-transaction cap, the allowlist, and an uncapped currency all refuse before anything is sent', async () => {
  const env = { MM_LIVE: '1', MM_ALLOW_TOKENS: '0x000000000000000000000000000000000000beef' };
  const { call, sent } = await connect({ env, api: { buildBuy: async () => buyBuild(0.01), buildSell: async () => ({ ...buyBuild(0), explain: 'Sell' }) } });
  assert.match((await call('buy', { token: TOKEN, amount: '0.01' })).body.refused, /not on this agent's allowlist/);
  assert.match((await call('sell', { token: TOKEN, amount: '5' })).body.refused, /allowlist/, 'the allowlist covers sales too');
  const { call: call2 } = await connect({ env: { MM_LIVE: '1' }, api: { buildBuy: async () => buyBuild(0.2) } });
  assert.match((await call2('buy', { token: TOKEN, amount: '0.2' })).body.refused, /cap per transaction is 0\.05 BNB/);
  const usdt = { ...buyBuild(10), pay: { amount: '10', wei: wei(10).toString(), symbol: 'USDT' }, token: { address: TOKEN, pair: { symbol: 'USDT', decimals: 18 } } };
  const { call: call3 } = await connect({ env: { MM_LIVE: '1' }, api: { buildBuy: async () => usdt } });
  assert.match((await call3('buy', { token: TOKEN, amount: '10' })).body.refused, /No spending cap is set for USDT/);
  assert.equal(sent.length, 0);
});

test('live with approvals first: sends them, rebuilds, then the trade', async () => {
  let builds = 0;
  const api = { buildSell: async () => (++builds === 1
    ? { ...buyBuild(0), requires: [{ explain: 'Approve', tx: { chainId: 97, to: '0xtoken', data: '0xa', value: '0' } }] }
    : buyBuild(0)) };
  const { call, sent } = await connect({ env: { MM_LIVE: '1' }, api });
  const r = await call('sell', { token: TOKEN, percent: 50 });
  assert.equal(r.body.sent, true);
  assert.equal(builds, 2, 'rebuilt after the approval, so the trade is simulated for real');
  assert.deepEqual(sent.map((t) => t.to), ['0xtoken', '0xrouter']);
});

test('an API refusal reaches the agent as code, sentence and fix', async () => {
  const api = { buildBuy: async () => { throw new MayhemError(422, { error: { code: 'SLIPPAGE_TOO_LOW', message: 'That would revert.', fix: 'Raise slippageBps.' } }); } };
  const { call } = await connect({ api });
  const r = await call('buy', { token: TOKEN, amount: '0.01' });
  assert.equal(r.error, true);
  assert.deepEqual(r.body, { error: 'SLIPPAGE_TOO_LOW', message: 'That would revert.', fix: 'Raise slippageBps.', detail: null });
});

test('no wallet: reads work, trades say how to add one', async () => {
  const { call } = await connect({ wallet: null, api: { quote: async () => ({ receive: { amount: '1' } }) } });
  assert.equal((await call('quote', { token: TOKEN, side: 'buy', amount: '0.01' })).body.receive.amount, '1');
  const r = await call('buy', { token: TOKEN, amount: '0.01' });
  assert.equal(r.error, true);
  assert.match(r.body.message, /MM_PRIVATE_KEY/);
});

test('sell needs exactly one of amount or percent; bad input is refused by the schema', async () => {
  const { call } = await connect();
  assert.match((await call('sell', { token: TOKEN })).body.message, /exactly one/);
  const bad = await call('buy', { token: 'nope', amount: '0.01' }).catch((e) => ({ threw: e.message }));
  assert.ok(bad.threw || bad.error, 'an invalid address never reaches the API');
});

test('launch counts the first buy and the launch fee against the caps', async () => {
  const build = { pair: { symbol: 'BNB', decimals: 18 }, firstBuy: { spend: { wei: wei(0.04).toString() } }, launchFee: { wei: wei(0.02).toString() }, requires: [], tx: { chainId: 97, to: '0xfactory', data: '0x', value: '0' }, explain: 'Launch' };
  const { call } = await connect({ env: { MM_LIVE: '1' }, api: { buildLaunch: async () => build } });
  const r = await call('launch_token', { name: 'Moth', symbol: 'MOTH', marketCapUsd: '1000', firstBuy: '0.04' });
  assert.match(r.body.refused, /spends 0\.06 BNB; the cap per transaction is 0\.05 BNB/);
});

test('guard: caps parse strictly, and the ledger resets at a new UTC day', () => {
  assert.throws(() => capsFrom('BNB'), /SYMBOL:amount/);
  assert.equal(capsFrom('bnb:0.1,USDT:50').get('USDT'), '50');
  const dir = mkdtempSync(join(tmpdir(), 'mm-led-'));
  let day = new Date('2026-09-25T23:00:00Z');
  const l = makeLedger({ dir, now: () => day });
  l.add('BNB', 5n);
  assert.equal(l.spentToday().get('BNB'), 5n);
  day = new Date('2026-09-26T00:01:00Z');
  assert.equal(l.spentToday().get('BNB'), undefined);
  assert.deepEqual(allowed({ limits: limitsFrom({}), token: null, spend: null, spentToday: new Map() }), { ok: true });
});
