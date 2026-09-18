# Changelog

Changes are recorded here by milestone. This project has not published a package
or enabled live trading.

## Unreleased

### Added

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

### Limitations

- No public exchange recorder, live market feed, live orders, or wallet support.
- No demonstrated trading profitability or validated strategy thresholds.
- Queue priority, market impact, exchange rounding, and post-only rejection during
  latency remain unmodeled. Final inventory is not liquidated.
- Jev transport is tested with mocks, not a credentialed API call.
- Walk-forward evaluation, calibration metrics, and cached model replay remain
  future milestones.
