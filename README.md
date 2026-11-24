# Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Jeytm/pump-sprint-booth-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Jeytm/pump-sprint-booth-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [make.fun](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) Pump.fun Paper Sprint. It replays on 6 hours of real pump.fun bonding-curve data; highest net PnL wins.

## Strategy: hot-launch sniper (v2)

v1 bought every fresh launch that passed a rug filter and lost -0.434 SOL:
381 mostly-cold coins, a 14% win rate, and fees eating the edge. v2 trades
far less and only where the heat is already proven. It buys a bigger stake
(0.25 SOL, capped at 1% of real reserves) in a launch **only** if, within its
first 5 slots:

- **Real SOL is piling in fast:** 20–60 SOL of real reserves already.
  Dev-window research: coins with >10 SOL real at age 5 reach +20% by slot 30
  17.5% of the time and complete 16% of the time, vs 6.7% / 3.1% for the
  average coin; coins with <1 SOL real at age 5 are dead (0.7% ever reach +20%).
- **Several distinct buyers:** 5–12 non-creator buyers, at least 0.5 SOL
  bought by non-creators.
- **No single wallet dominating:** the largest buyer's share of early buys is
  at most 40% — one wallet holding a third of a fresh launch is a bundle
  setting up a dump (one such coin alone cost v1's successor -0.13 SOL when
  its early buyers sold the whole curve in a single slot).
- **No dump signals:** creator's own buy in the create slot at most 2 SOL,
  creator has not sold, no single non-creator sell above 50% of real reserves,
  no net selling by others.

Then it banks fast and cuts fast:

- **Exits:** +15% take-profit, -6% stop-loss, 10-slot max hold, trailing stop
  (-15% from peak once up 10%), exit at once if the creator sells or a single
  non-creator sell of 1+ SOL lands while holding.
- **Guardrail backstop:** tiny 0.01 SOL probe round trips keep the run above 20
  coins when hot launches are scarce.

## Local grade (dev window, 24h of pump.fun data)

- Net PnL **+0.192 SOL** (return +1.9%), max drawdown 2.0%
- 250 fills over 64 coins, 125 round trips, win rate 10.4%
- Fees only 0.076 SOL curve + 0.027 SOL tx (v1 paid 0.399 SOL)
- Guardrails met (64 coins hold a round trip of at least 0.01 SOL)
- Deterministic: two executions reproduce byte for byte
- Honest caveats: the top 3 coins made 88% of the gains; without them net PnL
  is -0.16 SOL, and the 90% interval is -0.20 to +0.64 SOL. This is a
  high-variance runner-catching strategy — on a fresh 6-hour window it lives or
  dies by whether 1–2 big winners show up.

## Layout

- `main.ts` — the bot (Node 22, runs as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte for byte
