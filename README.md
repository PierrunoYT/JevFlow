# JevFlow
A trading bot powered by TypeSafe AI's Jev.

## Status: paper trading and experimental Testnet execution

This is a Bun/TypeScript CLI, not a production trading system. It records public Binance
spot market data and replays a single market, computes deterministic features,
evaluates buy/sell/hold, applies
risk checks, simulates maker fills, and writes an append-only JSONL audit log.
An experimental Binance Spot **Testnet-only** adapter adds authenticated balances,
maker orders, persistent reconciliation, and a kill switch. It defaults to dry-run
and cannot send orders to production. There is no wallet or real-money deposit path.
**Profitability is unproven; do not fund this bot with real money.**

### Testnet trading

Start with `bun run testnet check` (public connectivity only). Follow the
[Testnet operator guide](TESTNET_GUIDE.md) for virtual funds, credentials, explicit
execution opt-in, safeguards, and recovery. Authenticated order placement and
cancellation have not been verified against the exchange: this orb's public
Testnet check received HTTP 451. Do not bypass network or regional restrictions.

### Command quick reference

Run commands from the repository root. `FILE` is a normalized event JSONL file.

| Command | Credentials | Effect |
| --- | --- | --- |
| `bun run demo` | None | Offline synthetic simulation; writes a local audit |
| `bun run record BTCUSDT --seconds 60` | None | Public feed capture; writes local data |
| `bun run replay FILE` | None | Offline baseline simulation; writes a local audit |
| `bun run replay FILE --jev` | TypeSafe | Billable model calls; simulated orders only |
| `bun run testnet check` | None | Public Testnet connectivity, book, and filters |
| `bun run testnet status` | Testnet | Reads balances and open BTCUSDT orders |
| `bun run testnet run` | Testnet | Always-hold observer; updates local risk/audit state |
| `bun run testnet run --jev` | Testnet + TypeSafe | Billable predictions and dry-run proposals; no exchange writes |
| `bun run testnet run --jev --execute-testnet` | Testnet + TypeSafe | Can submit and cancel virtual-asset orders |
| `bun run testnet stop` | None | Writes a local stop request; cancellation is not guaranteed |
| `bun run testnet reconcile` | Testnet | Queries and may cancel the tracked order |
| `bun run testnet reset-risk --acknowledge-risk-reset` | Testnet | Checks exchange orders and explicitly resets local risk state |

See the [operator guide](TESTNET_GUIDE.md#stop-and-recover) before reconciliation
or risk reset. No command enables production trading or accepts real deposits.

### Documentation map

- [Testnet operator guide](TESTNET_GUIDE.md): setup, virtual funds, limits, stopping,
  and recovery.
- [Design guide](TRADING_BOT_GUIDE.md): implemented architecture versus proposed
  extensions; example snippets are not the current API.
- [Jev research](JEV_RESEARCH.md): provider and reference-bot research, not an
  operational guide or a current pricing guarantee.
- [Changelog](CHANGELOG.md): implementation milestones and known limitations.

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

### Record public market data

No exchange account, wallet, or API key is needed:

```bash
bun run record BTCUSDT --seconds 60 --out data/btc-session
bun run replay data/btc-session/events-0001.jsonl
```

The recorder defaults to BTCUSDT and 60 seconds; the maximum duration is 24 hours.
The output directory must not already exist. Ctrl+C closes the files cleanly.
It connects only to Binance's public market-data WebSocket, not a trading API.
Availability depends on network and regional exchange restrictions.

- `raw.jsonl` preserves every received payload with local receive time and
  connection segment, including messages rejected by validation. It also records
  segment-end reasons and totals. Exchange timestamps and source IDs remain in
  the raw payload. This file is **not** direct replay input.
- `events-0001.jsonl`, etc. contain normalized top-of-book and individual trade
  events. The Binance buyer-is-maker flag is converted to aggressor side.
- Full top-five snapshots arrive on `depth5@100ms`. The normalizer validates level
  ordering and uncrossed touch prices; only the touch is exported for replay.
  Full depth remains in the raw payload. Snapshot update IDs need not be consecutive.
- Consecutive trade IDs are checked. Immediate duplicate trades are discarded;
  gaps, regressions, invalid data, and book observation gaps over one second close
  the segment. A book watchdog also closes silent connections after ten seconds.
- Reconnect uses bounded exponential backoff (1–30 seconds). Every connection
  starts a new file and waits for a fresh snapshot before exporting trades.
  **Replay segments separately; never concatenate them across an outage.**
  Empty segments from failed connections are not valid replay input.

This deliberately does not backfill outages or claim complete exchange history.
Normalized timestamps use **local receive time** for both channels because the
partial-depth feed has no exchange timestamp. Replay therefore models observed
arrival order, not exact matching-engine order. Sub-second sampling loss, network
delays, and inter-channel timing can bias simulated fills. Use these captures for
integration and exploratory research, not profitability claims.

For a longer recording in an Amp orb, use a supervised service:

```bash
amp orb service start jevflow-recorder --command 'bun run record BTCUSDT --seconds 3600'
amp orb service logs jevflow-recorder
amp orb service stop jevflow-recorder
```

The default output directory is unique per run. A service supervisor can restart
the bounded command after it finishes, producing another session; stop the
service when enough data has been collected. No web server or portal is needed.

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

### Paper replay assumptions and limitations

- Decisions every five event-time seconds after five book observations. Features
  use up to 60 seconds of history; warmup does not require a full minute.
  VWAP is volume-weighted trade price (`null` with no trades); `volumeDelta` is
  taker-buy volume minus taker-sell volume over that rolling window, in base units.
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
- No concurrent live paper strategy, cached Jev replay, calibration metrics,
  walk-forward evaluation, or production execution. Testnet execution has separate
  limits and persistent order recovery; see the operator guide.

Next milestone: evaluate Jev against baselines on held-out recorded market data
and validate the authenticated Testnet lifecycle before considering real-money execution.
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
or start background services. Recording is opt-in; no resume hook is needed.
Setup becomes available to future default-branch orbs once
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
| `src/recorder.ts`, `src/record.ts` | Public Binance normalization, capture, reconnect, and CLI |
| `src/binance.ts` | Testnet-only signed REST transport and exact decimal sizing |
| `src/trading.ts`, `src/testnet.ts` | Durable intent, reconciliation, risk gates, and operator CLI |
| `src/bot.test.ts` | Offline unit and integration tests |
| `src/recorder.test.ts` | Feed validation and local WebSocket recovery tests |
| `src/trading.test.ts` | Mocked exchange lifecycle, decimal sizing, persistence, and failure tests |

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

Recorder and feature ideas were informed by
[`jarrodwatts/jev-trader`](https://github.com/jarrodwatts/jev-trader); no source was
copied. The recorder follows the
[official WebSocket protocol](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md).
The execution adapter follows the
[Spot Testnet REST documentation](https://github.com/binance/binance-spot-api-docs/blob/master/testnet/rest-api.md)
and [exchange filters](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md).
