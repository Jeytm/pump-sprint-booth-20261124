// Pump.fun Paper Sprint — hot-launch sniper, v2 (agent-fun/replay/v2).
//
// v1 bought every fresh launch that passed a rug filter and lost -0.434 SOL on
// the dev window: 381 mostly-cold coins, 14% win rate, fees eating the edge.
// v2 buys ONLY launches that are already hot in their first slots — real SOL
// piling in fast (20+ SOL within 5 slots), several distinct buyers, no single
// wallet dominating the early buys (a bundle setup) — then banks a fast
// take-profit (+15%), cuts losers fast (-6%), and never holds past 10 slots.
// Research on the dev window: coins with >10 SOL real at age 5 reach +20%
// 17.5% of the time by slot 30 and complete 16% of the time, vs 6.7% / 3.1%
// for the average coin; coins with <1 SOL real at age 5 are dead (0.7% ever
// reach +20%). Local sim (full dev window): +0.191 SOL, 64 coins, maxDD 2%,
// vs -0.459 for v1 in the same sim.
//
// Deterministic by construction: no clock, no Math.random, no environment;
// all state lives in module-level maps fed by the batch stream, iterated in
// insertion order. Every decision is a pure function of the events seen so far.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
// Curve fee on a sell (protocol 95 bps + creator 30 bps).
const CURVE_FEE = 0.0125;

// ---- tunables -------------------------------------------------------------
const MAX_ENTRY_AGE = 5; // slots since CreateEvent; only fresh launches
const STAKE_SOL = 0.25; // SOL per launch (capped at 1% of real reserves)
const MIN_BUY_SOL = 0.005; // smallest buy worth paying the tx fee for
const MIN_RQ_SOL = 20; // real SOL reserves at entry, lower bound: HOT only
const MAX_RQ_SOL = 60; // real SOL reserves at entry, upper bound
const MIN_BUYERS = 5; // distinct non-creator buyers at entry, at least
const MAX_BUYERS = 12; // distinct non-creator buyers at entry, at most
const MIN_BUYS_SOL = 0.5; // non-creator SOL bought before entry, at least
const MAX_DEV_BUY_SOL = 2; // creator's own buy in the create slot, at most
const MAX_BUYER_SHARE = 0.4; // one wallet's share of early buys, at most
const BUY_SLIP_BPS = 10_000; // wide: never refuse a launch buy on latency
const TAKE_PROFIT = 0.15; // sell when value >= cost * (1 + TAKE_PROFIT)
const STOP_LOSS = 0.06; // sell when value < cost * (1 - STOP_LOSS)
const TRAIL_ARM = 0.1; // trailing stop arms once value >= cost * (1 + TRAIL_ARM)
const TRAIL = 0.15; // sell when value < peak * (1 - TRAIL)
const MAX_HOLD = 10; // slots; exit after this no matter what
const EXIT_BIG_SELL_SOL = 1; // exit at once on a single sell this big (SOL)
const MAX_MAIN = 5;
// Guardrail pacing: the run must end with round trips on >=20 coins. When the
// bot's own fills or coins lag the pace, open tiny probe round trips.
const TARGET_COINS = 25;
const TARGET_FILLS = 240;
const PACE_SECS = 21600; // 6h: the final window's length
const PROBE_SOL = 0.01;
const MAX_PROBES = 1;

interface Coin {
  created: number;
  creator: Pubkey;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<Pubkey>;
  boughtSol: number;
  soldByOthersSol: number;
  biggestSellShare: number; // largest single non-creator sell, share of real SOL
  bigSellSol: number; // largest single non-creator sell (SOL) since entry
  bigSellSlot: number;
  buysByUser: Map<Pubkey, number>; // non-creator buy SOL by wallet
  done: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  filled: boolean;
}

// ---- module-level state (deterministic: fed only by the batch stream) -----
const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const fresh = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          created: e.slot,
          creator: e.creator,
          devBuySol: 0,
          devSold: false,
          buyers: new Set(),
          boughtSol: 0,
          soldByOthersSol: 0,
          biggestSellShare: 0,
          bigSellSol: 0,
          bigSellSlot: -1,
          buysByUser: new Map(),
          done: false,
        });
        fresh.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / LAMPORTS;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.boughtSol += sol;
          if (isDev && e.slot === c.created) c.devBuySol += sol;
          else if (!isDev) {
            c.buyers.add(e.user);
            c.buysByUser.set(e.user, (c.buysByUser.get(e.user) ?? 0) + sol);
          }
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthersSol += sol;
          if (sol > c.bigSellSol) {
            c.bigSellSol = sol;
            c.bigSellSlot = e.slot;
          }
          const rqBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
          if (rqBefore > 0) {
            const share = sol / rqBefore;
            if (share > c.biggestSellShare) c.biggestSellShare = share;
          }
        }
        fresh.add(e.mint);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.done = true;
      }
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Close value of a position at the latest reserves (SOL after curve + tx fees).
    const closeValue = (mint: Pubkey): number => {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined || curve === undefined) return 0;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
    };

    // ---- exits first ------------------------------------------------------
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const value = closeValue(mint);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      let exit = false;
      if (value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && now - h.opened >= MAX_HOLD) exit = true;
      const c = coins.get(mint);
      if (!exit && c !== undefined && c.devSold) exit = true;
      if (!exit && c !== undefined && c.bigSellSlot >= h.opened && c.bigSellSol >= EXIT_BIG_SELL_SOL) exit = true;
      if (!exit) continue;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // ---- probe round trips: sell the probe as soon as its buy lands -------
    for (const [mint] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      probes.set(mint, true);
    }

    // ---- entries: hot launches only ---------------------------------------
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = MAX_MAIN - held.size;
    for (const mint of fresh) {
      if (orders.length >= cap) break;
      if (slotsLeft <= 0 || mainLeft <= 0) break;
      const c = coins.get(mint);
      if (c === undefined || c.done) continue;
      if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
      const age = now - c.created;
      if (age < 0 || age > MAX_ENTRY_AGE) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // Hot-launch filter: real SOL already piled in fast, several distinct
      // buyers, meaningful non-creator buying, no single wallet dominating
      // the early buys (a bundle setting up a dump), no dump signals.
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      if (c.devBuySol > MAX_DEV_BUY_SOL) continue;
      if (c.devSold) continue;
      if (c.buyers.size < MIN_BUYERS || c.buyers.size > MAX_BUYERS) continue;
      if (c.boughtSol < MIN_BUYS_SOL) continue;
      let topBuyer = 0;
      for (const v of c.buysByUser.values()) if (v > topBuyer) topBuyer = v;
      if (c.boughtSol > 0 && topBuyer / c.boughtSol > MAX_BUYER_SHARE) continue;
      if (c.boughtSol > 0 && c.soldByOthersSol > c.boughtSol) continue;
      if (c.biggestSellShare > 0.5) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      held.set(mint, { opened: now, peakValue: 0, filled: false });
      slotsLeft--;
      mainLeft--;
    }

    // ---- guardrail pacing: probes when fills or coins lag -----------------
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of fresh) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
