import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData } from 'viem';

import { parseGammaMarketMeta } from '../src/market/polymarket.ts';
import { CTF_ABI, USDC_ADDRESS, createRedeemChain, redeemCalldata, RedeemUnavailableError } from '../src/live/redeemChain.ts';
import { createRedeemer, type RedeemChain } from '../src/live/redeemer.ts';
import { openLiveStore, type LiveStore } from '../src/live/liveStore.ts';

const COND_A = `0x${'a'.repeat(64)}`;
const COND_B = `0x${'b'.repeat(64)}`;
const KEY = `0x${'1'.repeat(64)}`;

function wonPosition(store: LiveStore, ws: number, conditionId: string | null, opts: { dryRun?: boolean; negRisk?: boolean } = {}) {
  const p = store.openPosition({
    windowStart: ws, side: 'UP', tokenId: 't', shares: 10, cost: 5, dryRun: opts.dryRun ?? false, nowMs: 0,
    conditionId, negRisk: opts.negRisk ?? false,
  });
  store.resolvePosition(p.id, true, 1);
  return p.id;
}

function fakeChain(resolved: Set<string>, fail = new Set<string>()): RedeemChain & { redeemed: string[] } {
  const c = {
    mode: 'direct' as const,
    redeemed: [] as string[],
    isResolved: async (id: string) => resolved.has(id),
    async redeem(id: string) {
      if (fail.has(id)) throw new Error('revert');
      c.redeemed.push(id);
      return { txHash: `0xtx${c.redeemed.length}` };
    },
  };
  return c;
}

describe('自动领奖', () => {
  it('赢的真单进入待领；按 conditionId 合并成一笔；链上未结算先不领', async () => {
    const store = openLiveStore(':memory:');
    const a1 = wonPosition(store, 100, COND_A);
    const a2 = wonPosition(store, 100, COND_A);
    const b = wonPosition(store, 400, COND_B);
    const chain = fakeChain(new Set([COND_A]));
    const r = createRedeemer({ store, chain });
    assert.equal(await r.runOnce(), 1);
    assert.deepEqual(chain.redeemed, [COND_A]);
    assert.equal(store.position(a1)!.redeemStatus, 'REDEEMED');
    assert.equal(store.position(a2)!.redeemTx, '0xtx1');
    assert.equal(store.position(b)!.redeemStatus, 'PENDING');
    assert.equal(store.position(b)!.redeemAttempts, 0);
    assert.equal(r.status().redeemedCount, 2);
  });

  it('输的、dry-run 的不领；缺 conditionId / neg-risk 转人工', async () => {
    const store = openLiveStore(':memory:');
    const lost = store.openPosition({ windowStart: 1, side: 'DOWN', tokenId: 't', shares: 1, cost: 1, dryRun: false, nowMs: 0, conditionId: COND_A });
    store.resolvePosition(lost.id, false, 1);
    const dry = wonPosition(store, 2, COND_A, { dryRun: true });
    const noCond = wonPosition(store, 3, null);
    const neg = wonPosition(store, 4, COND_B, { negRisk: true });
    const chain = fakeChain(new Set([COND_A, COND_B]));
    await createRedeemer({ store, chain }).runOnce();
    assert.deepEqual(chain.redeemed, []);
    assert.equal(store.position(lost.id)!.redeemStatus, null);
    assert.equal(store.position(dry)!.redeemStatus, null);
    assert.equal(store.position(noCond)!.redeemStatus, 'MANUAL');
    assert.equal(store.position(neg)!.redeemStatus, 'MANUAL');
  });

  it('失败重试，次数用完转人工', async () => {
    const store = openLiveStore(':memory:');
    const id = wonPosition(store, 100, COND_A);
    const r = createRedeemer({ store, chain: fakeChain(new Set([COND_A]), new Set([COND_A])), maxAttempts: 2 });
    await r.runOnce();
    assert.equal(store.position(id)!.redeemStatus, 'FAILED');
    await r.runOnce();
    assert.equal(store.position(id)!.redeemStatus, 'MANUAL');
    assert.equal(store.position(id)!.redeemError, 'revert');
    assert.equal(store.position(id)!.redeemAttempts, 2);
    assert.equal(r.status().lastError, 'revert');
  });

  it('同一时刻只跑一轮', async () => {
    const store = openLiveStore(':memory:');
    wonPosition(store, 100, COND_A);
    const chain = fakeChain(new Set([COND_A]));
    const r = createRedeemer({ store, chain });
    await Promise.all([r.runOnce(), r.runOnce()]);
    assert.equal(chain.redeemed.length, 1);
  });

  it('redeemPositions 编码：USDC、根集合、两个 indexSet', () => {
    const decoded = decodeFunctionData({ abi: CTF_ABI, data: redeemCalldata(COND_A) });
    assert.equal(decoded.functionName, 'redeemPositions');
    assert.deepEqual(decoded.args, [USDC_ADDRESS, `0x${'0'.repeat(64)}`, COND_A, [1n, 2n]]);
  });

  it('代理 / Safe 钱包没有 Builder 凭据时不启用', () => {
    assert.throws(() => createRedeemChain({ privateKey: KEY, signatureType: 2 }), RedeemUnavailableError);
    assert.equal(createRedeemChain({ privateKey: KEY, signatureType: 0 }).mode, 'direct');
    assert.equal(
      createRedeemChain({ privateKey: KEY, signatureType: 1, builderCreds: { key: 'k', secret: 's', passphrase: 'p' } }).mode,
      'relayer-proxy',
    );
  });

  it('老账本启动时补齐领奖相关列', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'live-')), 'live.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE live_position (id INTEGER PRIMARY KEY AUTOINCREMENT, window_start INTEGER NOT NULL, side TEXT NOT NULL,
      token_id TEXT NOT NULL, shares REAL NOT NULL, cost REAL NOT NULL, proceeds REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'OPEN',
      payout REAL, dry_run INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    old.close();
    const store = openLiveStore(file);
    const id = wonPosition(store, 1, COND_A);
    assert.equal(store.position(id)!.conditionId, COND_A);
    assert.equal(store.position(id)!.redeemStatus, 'PENDING');
    store.close();
  });

  it('Gamma 解析 conditionId / negRisk，优先 slug 匹配', () => {
    const event = {
      markets: [
        { slug: 'other', conditionId: COND_B, negRisk: true },
        { slug: 'btc-updown-5m-1', conditionId: COND_A, negRisk: false },
      ],
    };
    assert.deepEqual(parseGammaMarketMeta(event, 'btc-updown-5m-1'), { conditionId: COND_A, negRisk: false });
    assert.deepEqual(parseGammaMarketMeta({ markets: [{ conditionId: 'bad' }] }, 'x'), { conditionId: null, negRisk: false });
    assert.equal(parseGammaMarketMeta({}, 'x'), null);
  });
});
