// Pump.fun Paper Sprint — launch scalper (agent-fun/replay/v2).
//
// Idea: a bonding curve is cheapest at birth, before anyone else has bought.
// This bot watches every CreateEvent, buys a small stake in launches that pass
// a rug filter (creator did not load up, creator has not sold, not bundled by
// many wallets, no big early sell), then exits fast: +20% take-profit, -8%
// stop-loss, or 15 slots, whichever comes first. Losers are tiny and quick;
// winners are banked before the dump. A probe backstop keeps the run above the
// guardrail (round trips of >=0.01 SOL on >=20 coins) when launches are scarce.
//
// Deterministic by construction: no clock, no Math.random, no environment;
// all state lives in module-level maps fed by the batch stream, iterated in
// insertion order. Every decision is a pure function of the events seen so far.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
// Curve fee on a sell (protocol 95 bps + creator 30 bps).
const CURVE_FEE = 0.0125;

// ---- tunables -------------------------------------------------------------
const MAX_ENTRY_AGE = 5; // slots since CreateEvent; only fresh launches
const STAKE_SOL = 0.08; // SOL per launch
const MIN_BUY_SOL = 0.005; // smallest buy worth paying the tx fee for
const MIN_RQ_SOL = 0.2; // real SOL reserves at entry, lower bound
const MAX_RQ_SOL = 25; // real SOL reserves at entry, upper bound
const MAX_DEV_BUY_SOL = 2; // creator's own buy in the create slot, at most
const MAX_BUYERS = 4; // distinct non-creator buyers at entry, at most
const BUY_SLIP_BPS = 10_000; // wide: never refuse a launch buy on latency
const TAKE_PROFIT = 0.2; // sell when value >= cost * (1 + TAKE_PROFIT)
const STOP_LOSS = 0.08; // sell when value < cost * (1 - STOP_LOSS)
const TRAIL_ARM = 0.1; // trailing stop arms once value >= cost * (1 + TRAIL_ARM)
const TRAIL = 0.15; // sell when value < peak * (1 - TRAIL)
const MAX_HOLD = 15; // slots; exit after this no matter what
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
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthersSol += sol;
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

    // ---- entries: fresh launches that pass the rug filter -----------------
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
      // Rug filter.
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      if (c.devBuySol > MAX_DEV_BUY_SOL) continue;
      if (c.devSold) continue;
      if (c.buyers.size > MAX_BUYERS) continue;
      if (c.buyers.size < 1) continue; // someone besides the creator must have bought
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
