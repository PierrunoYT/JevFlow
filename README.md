# JevFlow
A trading bot powered by TypeSafe AI's Jev.

## Status: offline paper-trading foundation

This is a Bun/TypeScript CLI, not a live trading system. It replays a single
spot market, computes deterministic features, evaluates buy/sell/hold, applies
risk checks, simulates maker fills, and writes an append-only JSONL audit log.
There is no wallet, exchange authentication, or live order adapter.

### Run without credentials

Requires Bun 1.3 or newer.

Development and orb setup use Bun **1.3.10**, pinned in `package.json`.

```bash
bun install
bun test
bun run typecheck
bun run demo
```

The demo runs four minutes of synthetic events immediately. It uses an explicitly
uncalibrated order-book imbalance baseline, **not Jev**. Its results are smoke-test
output, not evidence of profitability. The printed summary includes fees,
mark-to-market P&L, inventory, fills, drawdown, and the audit file path.

### Replay recorded data

Supply one raw market event per JSONL line, ordered by timestamp, from one market:

```json
{"type":"book","market":"BTC-USD","timestampMs":1800000000000,"bid":100000,"ask":100002,"bidSize":2,"askSize":1}
{"type":"trade","market":"BTC-USD","timestampMs":1800000000200,"price":99999,"size":0.002,"side":"sell"}
```

Prices are quote currency per base unit; sizes are base units. Trade `side` is the
aggressor side. Book sizes refer to the best bid and ask. Invalid, crossed,
out-of-order, or mixed-market inputs stop the run. Existing audit files are never
overwritten. Failed runs may leave a partial audit without a summary.

```bash
bun run replay data/events.jsonl
bun run replay data/events.jsonl --out data/my-run.jsonl
```

Audit logs contain wrapped market events, decisions, complete probability
distributions, orders, fills, and future-mid labels. Extract raw events to replay
an earlier run with `jq`:

```bash
jq -c 'select(.type == "market") | .event' data/my-run.jsonl > data/events-copy.jsonl
bun run replay data/events-copy.jsonl
```

### Opt into Jev

Copy `.env.example` to `.env` and set `TYPESAFE_API_KEY`. Never commit credentials.
Then explicitly enable **billable API calls** for your recorded snapshots:

```bash
bun run replay data/events.jsonl --jev
```

The HTTP client uses `jev-1.13.0`, a 60-second question horizon, a one-second
timeout, and no retries. Failures, invalid distributions, late responses, and
weak predictions become hold; hold cancels any resting order. This is historical
inference, not a live feed. Jev receives market features only, never the API key
in its state. Transport tests use mocked responses; real API compatibility and
model availability still need a credentialed smoke test.

### Current assumptions and limitations

- Decisions every five event-time seconds after five book observations. Features
  use up to 60 seconds of history; warmup does not require a full minute.
- $10,000 starting cash; long-only; $100 orders; $500 maximum proposed exposure;
  one open order; 10 bps maximum spread; 10 bps fee on each fill. See `src/paper.ts`.
- A $25 **run-level** equity drawdown permanently halts orders and cancels the
  resting order. It does not liquidate inventory or reset daily.
- Probability ≥ 0.65 and confidence ≥ 0.55 are unvalidated gates, not an expected
  value calculation. Baseline probabilities are synthetic placeholders.
- Orders join the best bid/ask and expire after 15 seconds. Only subsequent,
  opposite-side trades strictly through the limit can fill, capped by observed
  volume. Inference latency delays fill eligibility. Books older than one second
  cancel orders. This is an approximation, not an exchange queue simulator:
  network/acknowledgement delays, post-only rejections during latency, full-depth
  queue priority, tick/lot rounding, and market impact are not modeled yet.
- Remaining inventory is marked at the last midpoint, not forcibly liquidated;
  liquidation costs and stale final marks can change realizable P&L.
- Outcome labels use the first book at or after 60 seconds and record any delay.
  Unfinished horizons remain unlabelled. These are direction labels, not fill P&L.
- No exchange recorder, live paper feed, cached Jev replay, calibration metrics,
  walk-forward evaluation, persistence recovery, or live execution yet.

Next milestone: record a chosen exchange's public book/trade stream, validate
sequence integrity, and evaluate Jev against baselines on held-out market data.
See [the research](JEV_RESEARCH.md) and [the design guide](TRADING_BOT_GUIDE.md).

## Development and orb setup

Fresh Amp orbs run `.agents/setup` automatically when setup is required. It
ensures Bun 1.3.10 and installs dependencies using `bun.lock` with
`--frozen-lockfile`. It can also be run manually:

```bash
./.agents/setup
bun test
bun run typecheck
```

Setup is non-interactive and safe to repeat. It needs network access for missing
dependencies; installing Bun also requires `curl` and `unzip`, available in the
standard orb image. It does not create `.env`, configure credentials, call Jev,
or start background services. No resume hook or service configuration is needed
for this offline CLI. Setup becomes available to future default-branch orbs once
committed and pushed to `main`.

### Code ownership and verification

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Runtime input/answer schemas and shared types |
| `src/features.ts` | Event-time rolling market features |
| `src/jev.ts` | Jev request/state design and offline baseline |
| `src/paper.ts` | Risk limits, order lifecycle, fills, and portfolio |
| `src/replay.ts` | Chronological processing, decision gates, audit, and outcomes |
| `src/index.ts` | CLI, synthetic events, file input/output |
| `src/bot.test.ts` | Offline unit and integration tests |

Run both tests and typechecking before committing. Tests require no API key and
make no external model requests. Changing execution semantics requires updating
the Jev prompt and fill tests together. Never treat synthetic demo P&L as a
strategy benchmark or add a live private key to replay data.

For CLI smoke testing, run `bun run demo`, extract the market events using the
`jq` command above, and replay them with the default baseline. Final summaries
should match exactly. `--jev` makes fresh API calls, so its latency and results
are not guaranteed to reproduce a previous run.

If an output path already exists, choose another path; the CLI deliberately
refuses to overwrite it. A malformed input stops the run: fix the event source
rather than sorting or silently dropping events, which can hide feed errors.
If Jev fails, inspect decision `reason` and `riskReason`; provider error bodies
are intentionally not persisted. Check credentials and model availability
separately without printing secrets.

See [CHANGELOG.md](CHANGELOG.md) for milestone changes.
