# JevFlow

A Kraken-only Bitcoin/Swiss-franc spot bot with optional TypeSafe AI Jev decisions,
public market recording, offline paper replay, and an experimental execution CLI.

**Dry-run is the default. Live mode uses real Kraken balances, not a Testnet.**
Profitability is unproven. Authenticated placement, fills, cancellation, and Jev
compatibility still need credentialed validation; no real orders were placed
during development. Public connectivity is not proof of trading readiness.

Start with the **[Kraken setup and recovery guide](KRAKEN_GUIDE.md)** for Swiss
account setup, CHF funding, API permissions, validation, live opt-in, and stopping.
Funds stay at Kraken; the bot cannot deposit or withdraw money.

## Quick start without credentials

Use Bun 1.3.10 (pinned in `package.json`), from the repository root:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run demo
bun run kraken check
```

The demo simulates four minutes of synthetic data immediately using an
**uncalibrated imbalance baseline**, not Jev. Its P&L is smoke-test output, not a
strategy benchmark. `kraken check` reads public BTC/CHF rules and market data only.

## Commands and side effects

| Command | Credentials | Effect |
| --- | --- | --- |
| `bun run demo` | None | Offline simulation and local audit |
| `bun run record BTC/CHF --seconds 60` | None | Public Kraken WebSocket capture |
| `bun run replay FILE` | None | Offline baseline simulation |
| `bun run replay FILE --jev` | TypeSafe | Billable predictions; simulated orders |
| `bun run kraken check` | None | Public BTC/CHF rules and book |
| `bun run kraken status` | Kraken | Reads balances/orders; updates local nonce |
| `bun run kraken run` | Kraken | Always-hold observer; local risk/audit updates |
| `bun run kraken run --jev` | Kraken + TypeSafe | Billable predictions and dry-run proposals |
| `bun run kraken validate` | Kraken with order permission | AddOrder with `validate=true`; no order placed |
| `bun run kraken stop` | None | Local stop request; not cancellation confirmation |
| `bun run kraken reconcile --acknowledge-live` | Kraken with cancellation permission | May cancel the tracked real order |
| `bun run kraken reset-risk --acknowledge-risk-reset` | Kraken | Checks orders and resets local risk state |

Real submissions require `--jev --execute-live --acknowledge-live` **and**
`KRAKEN_ENABLE_LIVE=I_ACCEPT_REAL_MONEY_RISK`. Follow the guide before enabling
them. Never grant withdrawal permission. All private commands share a local lock;
do not run `status` alongside the trader or share the key across machines.

Live limits: CHF 10/order, CHF 50 account-pair allocation and proposed BTC exposure,
CHF 5 persisted account-pair drawdown halt, ten submission attempts per UTC day.
These are software gates, not guarantees against loss or exchange-side API limits.
Kraken minimums can prevent an order; the bot never increases the cap to meet them.

## Record and replay Kraken data

```bash
bun run record BTC/CHF --seconds 60 --out data/btc-session
bun run replay data/btc-session/events-0001.jsonl
```

Only BTC/CHF is supported for network recording/trading. Recording defaults to
60 seconds (maximum 24 hours), refuses an existing output directory, and supports
Ctrl+C. Replay stays exchange-independent for existing normalized data.

- `raw.jsonl` retains exact WebSocket payload strings, receive times, segment-end
  reasons, and totals. It is **not** replay input.
- `events-0001.jsonl`, etc. contain normalized books/trades per connection.
- Kraken v2 `ticker` uses `event_trigger=bbo`; `trade` disables historical snapshots.
  Only top-of-book is captured, not full depth or every quantity-only book change.
- Batched trades retain array order and share receipt time. Trade IDs deduplicate
  within a connection; no consecutive-ID or complete-history claim is made.
- Trades before the first book are omitted. Invalid/crossed/wrong-market data,
  stale data over 30 seconds, or future timestamps over five seconds close the
  segment. Thirty seconds without market data also closes the connection. An
  unchanged quiet market can therefore produce conservative reconnects.
- Reconnect waits 1–30 seconds. Every connection gets a separate replay file.
  **Never concatenate segments across outages.** Empty segments cannot be replayed.

Receive-time ordering, ticker sampling, network delays, and unavailable depth
bias simulated fills. There is no outage backfill or matching-engine reconstruction.

For long captures in an Amp orb:

```bash
amp orb service start jevflow-recorder --command 'bun run record BTC/CHF --seconds 3600'
amp orb service logs jevflow-recorder
amp orb service stop jevflow-recorder
```

The default directory is unique per run. A supervisor may restart the bounded
command when it ends; stop the service when enough data has been collected.

## Replay format and assumptions

One normalized event per JSONL line, chronological and from one market:

```json
{"type":"book","market":"BTC/CHF","timestampMs":1800000000000,"bid":65000,"ask":65002,"bidSize":2,"askSize":1}
{"type":"trade","market":"BTC/CHF","timestampMs":1800000000200,"price":64999,"size":0.002,"side":"sell"}
```

Prices are quote currency per BTC; sizes are BTC. Trade side is the aggressor.
Invalid, crossed, mixed-market, or out-of-order events stop replay. Existing audit
files are never overwritten; failures may leave partial logs.

```bash
bun run replay data/events.jsonl --out data/my-run.jsonl
# Extract market events from a replay audit, not the recorder's raw payload file:
jq -c 'select(.type == "market") | .event' data/my-run.jsonl > data/events-copy.jsonl
bun run replay data/events-copy.jsonl
```

Paper limits are deliberately separate from real execution: 10,000 quote units
starting cash, 100/order, 500 exposure, 25 run-level drawdown, and 0.1% fee/fill.
The fee is a simulation assumption, **not Kraken's actual fee schedule**.
Orders fill only on later, opposite-side strict trade-throughs, capped by observed
volume. Latency delays eligibility; stale books over one second cancel orders;
orders expire at 15 seconds. Queue priority, exchange rounding, market impact,
and post-only rejections are not modeled. Inventory is marked, not liquidated.

Features use up to 60 seconds of history; replay starts after five book observations
and evaluates every five event-time seconds. VWAP is null without trades; volume
delta is taker buy minus sell volume. Future-mid labels use the first observation
at/after 60 seconds and record delay, not profitable-fill probabilities.

Copy `.env.example` to ignored `.env` and set `TYPESAFE_API_KEY` to opt into
`--jev`. The HTTP client pins `jev-1.13.0`, asks buy/sell/hold over a 60-second horizon,
and uses a one-second timeout without retries. Gates require probability ≥ 0.65
and confidence ≥ 0.55; these are unvalidated. Never reverse a blocked buy into a
sell. Failed replay predictions hold/cancel; execution failures latch a halt.

## Development and documentation

Fresh orbs run `.agents/setup`: installs Bun 1.3.10 if necessary and dependencies
with the frozen lockfile. It can be rerun manually and never creates credentials,
starts trading, or calls Jev. Missing toolchain installation needs network access,
`curl`, and `unzip`.

| Module | Responsibility |
| --- | --- |
| `src/types.ts`, `src/features.ts` | Input/answer contracts and rolling features |
| `src/jev.ts` | Jev HTTP requests, prompt, and offline baseline |
| `src/paper.ts`, `src/replay.ts`, `src/index.ts` | Simulation, audit, and replay CLI |
| `src/recorder.ts`, `src/record.ts` | Kraken v2 recording and normalization |
| `src/kraken.ts` | Kraken REST, signatures, balances, sizing, and orders |
| `src/trading.ts`, `src/trade.ts` | Durable intent/nonce, reconciliation, risk, and CLI |
| `src/*.test.ts` | Offline contracts, execution failures, and local WebSocket tests |

Run `bun test`, `bun run typecheck`, and `git diff --check` before committing.
Tests need no real keys or external requests. For replay smoke checks, extract
and replay a demo's events; baseline summaries should match. Model calls are
billable and not guaranteed reproducible.

- [Kraken guide](KRAKEN_GUIDE.md): setup, funding, permissions, limits, recovery,
  and migration from the removed Binance adapter.
- [Design guide](TRADING_BOT_GUIDE.md): actual implementation versus proposed examples.
- [Research notes](JEV_RESEARCH.md): historical provider/reference-bot research.
- [Changelog](CHANGELOG.md): milestones and limitations.

Recorder/feature ideas were informed by
[`jarrodwatts/jev-trader`](https://github.com/jarrodwatts/jev-trader); no source was copied.
Kraken's [ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker)
and [trade](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade)
documentation describes the public feed. REST sources are linked in the setup guide.
