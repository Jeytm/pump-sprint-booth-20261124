# Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Jeytm/pump-sprint-booth-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Jeytm/pump-sprint-booth-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [make.fun](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) Pump.fun Paper Sprint. It replays on 6 hours of real pump.fun bonding-curve data; highest net PnL wins.

## Strategy: launch scalper

A bonding curve is cheapest at birth, before anyone else has bought. The bot
watches every `CreateEvent`, buys a small stake (0.08 SOL, capped at 1% of real
reserves) in launches that pass a rug filter, then exits fast:

- **Rug filter:** creator's own buy in the create slot at most 2 SOL, creator
  has not sold, at most 4 distinct non-creator buyers (a launch bundled by many
  wallets is a dump in waiting), at least 1 non-creator buyer, no big early sell.
- **Exits:** +20% take-profit, -8% stop-loss, 15-slot max hold, trailing stop
  (-15% from peak once up 10%), exit at once if the creator sells.
- **Guardrail backstop:** tiny 0.01 SOL probe round trips keep the run above 20
  coins when launches are scarce.

## Local grade (dev window, 24h of pump.fun data)

- Net PnL **-0.434 SOL** (return -4.3%), max drawdown 4.6%
- 812 fills over 378 coins, 406 round trips, win rate 14.3%
- Guardrails met (323 coins hold a round trip of at least 0.01 SOL)
- Deterministic: two executions reproduce byte for byte
- For reference, the kit's tuned pilot sniper scores -0.423 SOL on the same window

## Layout

- `main.ts` — the bot (Node 22, runs as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte for byte
