# Changelog

Changes are recorded here by milestone. This project has not published a package
or enabled production trading. Experimental Testnet execution uses virtual assets.

## Unreleased

### Added

- Experimental BTCUSDT Binance Spot Testnet adapter with HMAC signing, clock
  synchronization, exact decimal tick/lot/notional sizing, free-balance checks,
  maker-only orders, sanitized failures, and rate-limit cooldown.
- Dry-run-by-default Testnet CLI with explicit Jev/execution opt-ins, authenticated
  balance/status checks, manual stop, tracked-order reconciliation, and explicit
  risk reset. No production endpoint or real-money deposit support.
- SQLite intent persistence before submission, restart reconciliation, terminal
  cancellation confirmation, API-key binding, local process lock, persistent
  drawdown halt, daily attempt cap, and private execution audit.
- Mocked tests for lost acknowledgements, partial fills, cancel/fill races,
  unresolved orders, restart recovery, concurrent cycles, expiry, stale decisions,
  kill switches, dry-run isolation, decimal limits, and signed transport.
- Testnet operator guide covering virtual funds, setup, limitations, and recovery.
- Credential-free Binance spot recorder with raw payload capture and separate
  replay files for each connection. Includes trade-ID continuity checks,
  duplicate suppression, snapshot validation, stale-book detection, bounded
  reconnect backoff, graceful shutdown, and local WebSocket recovery tests.
- Rolling 60-second VWAP and taker volume delta in deterministic model features.
- Initial Bun/TypeScript offline paper trader with synthetic demo and streaming
  JSONL replay for one spot market.
- Deterministic rolling returns, spread, top-of-book imbalance, and taker-flow
  imbalance features.
- Optional Jev HTTP integration pinned to `jev-1.13.0`, with buy/sell/hold,
  probability validation, confidence gates, timeout, and failure-to-hold behavior.
- Explicitly uncalibrated imbalance baseline for credential-free smoke tests.
- Long-only paper broker with cash and exposure checks, one resting order,
  run-level drawdown halt, order expiry, and stale-book cancellation.
- Volume-capped partial maker fills on later trade-throughs, inference-latency
  eligibility, fees, inventory, and mark-to-market accounting.
- Append-only audit output with decisions, distributions, orders, fills, future
  midpoint labels, and final summaries; existing output files are protected.
- Tests for features, input validation, accounting, risk limits, failure paths,
  replay determinism, and the mocked Jev HTTP contract.
- Executable, idempotent `.agents/setup` with pinned Bun and locked dependencies.
- CLI usage, data format, development workflow, and simulation limitations.

### Documentation

- Added a command/credential/side-effect reference and documentation map.
- Distinguished implemented features from proposed SDK, feature, and strategy
  examples in the design guide; separated Testnet validation from production use.
- Updated research notes to reflect the current implementation and clearly mark
  provider figures and reference-repository observations as historical research.

### Limitations

- Public capture is receive-time ordered and uses sampled top-five snapshots;
  there is no full-depth delta reconstruction or outage backfill. Replay each
  connection segment separately. No concurrent live paper strategy, production
  orders, or wallet support.
- Testnet execution is REST-polled and book-only, with no trade-flow feed or
  server-side expiry. Unknown submissions remain blocked pending confirmed
  reconciliation; cancellation cannot be guaranteed during outages.
- Authenticated Testnet lifecycle remains unverified; the orb's public check
  returned HTTP 451. Mock coverage is not exchange integration validation.
- No demonstrated trading profitability or validated strategy thresholds.
- In paper replay, queue priority, market impact, exchange rounding, and post-only
  rejection during latency remain unmodeled. Final inventory is not liquidated.
- Jev transport is tested with mocks, not a credentialed API call.
- Walk-forward evaluation, calibration metrics, and cached model replay remain
  future milestones.
