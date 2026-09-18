# Building a Trading Bot with TypeSafe AI's Jev

Use Jev as the **decision layer**, surrounded by deterministic market-data, risk, execution, and accounting code. Do not let Jev directly place trades or calculate indicators.

## What is implemented today

This document is a design guide, not a copy-and-run implementation manual.
Use [README.md](README.md) for supported commands and
[TESTNET_GUIDE.md](TESTNET_GUIDE.md) for credentials, virtual funds, and recovery.

- Public Binance recording and offline single-market paper replay are implemented.
- `src/jev.ts` uses direct HTTP, pinned `jev-1.13.0`, and one `direction` Choice
  question with buy/sell/hold. The SDK and multi-question examples below are
  proposals, not installed dependencies or active strategy gates.
- `src/types.ts` defines the actual feature contract: midpoint, spread, rolling
  return, book/flow imbalance, volume delta, VWAP, and observation count.
  Volatility, multi-horizon returns, depth bands, and portfolio features in the
  examples below are not currently supplied to Jev.
- `src/binance.ts`, `src/trading.ts`, and `src/testnet.ts` implement experimental
  BTCUSDT Spot Testnet execution. It defaults to dry-run, uses book-only REST
  observations, and persists order intent, risk state, and audit data in SQLite.
  It does not share the recorder's trade stream or reproduce paper fills.
- Testnet caps are 25 USDT per order, 500 USDT proposed BTC exposure, 100 submission
  attempts per UTC day, and a persisted 25 USDT account-pair drawdown halt.
  The drawdown is not a daily strategy-loss calculation. Paper replay instead
  uses $100 orders and a run-level drawdown halt; see the README.
- Authenticated exchange placement/cancellation and Jev compatibility remain
  unverified. The orb's public Testnet check returned HTTP 451. No production
  adapter, real-money funding, or demonstrated profitability is available.

## Recommended architecture

```text
exchange WebSocket/API
        ↓
order-book and trade recorder
        ↓
deterministic feature engine
        ↓
Jev decision: buy / sell / hold
        ↓
confidence + probability gate
        ↓
deterministic risk engine
        ↓
paper/live execution adapter
        ↓
fills, positions, P&L, audit log
```

Jev should answer narrow questions. Ordinary code must own:

- Returns, volatility, VWAP, volume delta, and order-book imbalance.
- Position and order sizing.
- Fee, spread, slippage, and gas calculations.
- Exposure and drawdown limits.
- Order construction and signing.
- API retries, reconciliation, and stale-data detection.
- Private keys. Never include credentials in Jev state.

## Start at a slower cadence

Jev requests normally take roughly 70–500 ms. Do not begin with one decision every 300 ms as the reference trader does. Start with:

- Decisions every 5–60 seconds.
- A 30–300 second prediction horizon.
- Paper trading only.
- Post-only orders or simulated taker orders, but not both under the same prompt.

The execution described to Jev must exactly match the actual execution path.

## Proposed expanded project structure

The layout below is a future decomposition, not the current directory tree.
The README's module table maps the existing implementation.

```text
src/
  config.ts
  types.ts
  market/
    adapter.ts
    paper-feed.ts
    exchange-feed.ts
  features.ts
  jev.ts
  risk.ts
  strategy.ts
  execution/
    paper.ts
    live.ts
  portfolio.ts
  recorder.ts
  replay.ts
  index.ts
data/
  events.jsonl
```

Keep exchange-specific code behind interfaces:

```ts
interface MarketFeed {
  snapshot(): Promise<MarketSnapshot>;
  subscribe(handler: (event: MarketEvent) => void): Promise<void>;
}

interface Execution {
  place(order: OrderRequest): Promise<OrderResult>;
  cancel(orderId: string): Promise<void>;
  openOrders(): Promise<OpenOrder[]>;
}
```

These proposed interfaces could support strategy reuse. They do not establish
equivalence between the current replay and Testnet paths.

## Build deterministic features

Jev 1.13 is explicitly weak at arithmetic and numeric precision. Calculate everything first:

```ts
export interface Features {
  market: string;
  timestampMs: number;
  dataAgeMs: number;

  mid: number;
  spreadBps: number;
  volatilityBps: number;

  return1: number;
  return5: number;
  return20: number;

  bookImbalance: number;
  takerFlowImbalance: number;
  bidDepth: number;
  askDepth: number;

  position: number;
  maxPosition: number;
}
```

Also provide semantic buckets so Jev does not need to infer every numeric relationship:

```ts
function describeFeatures(f: Features) {
  return {
    market: f.market,
    horizonSeconds: 60,

    execution: {
      style: "post-only maker limit order",
      behavior: "Order joins the best bid or ask and may not fill.",
    },

    marketState: {
      spread: f.spreadBps < 2 ? "tight" : f.spreadBps < 8 ? "normal" : "wide",
      volatility:
        f.volatilityBps < 5 ? "low" :
        f.volatilityBps < 20 ? "normal" :
        "high",
      shortMomentum:
        f.return5 > 3 ? "up" :
        f.return5 < -3 ? "down" :
        "flat",
      bookPressure:
        f.bookImbalance > 0.2 ? "bid-heavy" :
        f.bookImbalance < -0.2 ? "ask-heavy" :
        "balanced",
      takerFlow:
        f.takerFlowImbalance > 0.2 ? "buyers-aggressive" :
        f.takerFlowImbalance < -0.2 ? "sellers-aggressive" :
        "mixed",
    },

    computedValues: f,
  };
}
```

The raw values remain available, but code has already performed the exact arithmetic.

## Ask Jev atomic questions

For an optional future SDK integration (not needed to run JevFlow):

```bash
bun add ai @ai-sdk/typesafe-ai
```

Set the API key outside source control:

```dotenv
TYPESAFE_API_KEY=...
```

A decision module could look like this:

```ts
import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";

const model = typeSafeAi.evaluationModel("jev-1.13.0");

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question:
        "Which action best fits the expected market direction over the next 60 seconds?",
      execution:
        "A buy posts a post-only bid. A sell posts a post-only ask. Hold places no order.",
      evidence:
        "Use marketState, order-book pressure, taker flow, momentum, spread, and volatility.",
    },
    criteria: {
      buy: "Evidence consistently supports upward pressure.",
      sell: "Evidence consistently supports downward pressure.",
      hold: "Evidence is weak, contradictory, unstable, or insufficient.",
    },
  },

  flowPersistence: {
    type: "choice",
    instructions:
      "How persistent is the current directional order flow likely to be over the next 60 seconds?",
    criteria: {
      persistent: "Several independent signals support the same direction.",
      temporary: "The move appears short-lived or isolated.",
      unclear: "Signals conflict or there is insufficient evidence.",
    },
  },

  adverseSelection: {
    type: "score",
    instructions:
      "How likely is a newly posted maker order to be filled immediately before price moves against it?",
    criteria: [
      "Low risk: stable market with supportive depth and flow.",
      "Moderate risk: some conflicting or unstable evidence.",
      "High risk: toxic flow, rapidly changing book, or strongly one-sided pressure.",
    ],
  },

  suitableToTrade: {
    type: "noul",
    instructions:
      "Is the current evidence sufficiently clear and internally consistent to justify placing a new order?",
    criteria: {
      true: "Multiple independent signals support a trade.",
      false: "Signals are weak, contradictory, stale, or incomplete.",
    },
  },
} as const;

export async function askJev(features: Features) {
  const started = performance.now();

  const result = await experimental_evaluate({
    model,
    state: describeFeatures(features),
    questions: QUESTIONS,
    maxRetries: 0,
  });

  return {
    answers: result.answers,
    model: result.model,
    inputTokens: result.usage?.inputTokens ?? 0,
    latencyMs: performance.now() - started,
  };
}
```

Pin `jev-1.13.0` while evaluating it. Using `jev-latest` can silently change behavior when TypeSafe updates the alias.

## Gate the answer in code

Do not execute merely because the top answer is `buy` or `sell`.

```ts
type Action = "buy" | "sell" | "hold";

interface StrategyDecision {
  action: Action;
  reason: string;
  probability: number;
  confidence: number;
}

function applyDecisionGate(
  features: Features,
  result: Awaited<ReturnType<typeof askJev>>,
): StrategyDecision {
  const direction = result.answers.direction;
  const persistence = result.answers.flowPersistence;
  const adverse = result.answers.adverseSelection;
  const suitable = result.answers.suitableToTrade;

  if (features.dataAgeMs > 1_000) {
    return hold("market data is stale");
  }

  if (result.latencyMs > 1_000) {
    return hold("decision arrived too late");
  }

  if (direction.choice === "hold") {
    return hold("Jev selected hold");
  }

  const probability = direction.probabilities[direction.choice] ?? 0;

  // Conservative placeholders. Tune only on held-out replay data.
  if (probability < 0.65) {
    return hold("direction probability below threshold");
  }

  if (direction.confidence < 0.55) {
    return hold("direction distribution is too ambiguous");
  }

  if (suitable.noul < 0.75) {
    return hold("trade suitability below threshold");
  }

  if (
    persistence.choice !== "persistent" ||
    persistence.confidence < 0.5
  ) {
    return hold("flow is not persistently directional");
  }

  if (adverse.score > 0.8) {
    return hold("adverse-selection risk is elevated");
  }

  return {
    action: direction.choice,
    probability,
    confidence: direction.confidence,
    reason: "passed model and deterministic gates",
  };
}

function hold(reason: string): StrategyDecision {
  return {
    action: "hold",
    probability: 0,
    confidence: 1,
    reason,
  };
}
```

Those thresholds are illustrative placeholders, not safety guarantees or
validated trading parameters. Only the direction probability and confidence
gates are implemented today; the additional questions above are proposals.

## Add an independent risk engine

The risk engine runs after Jev and must be capable of rejecting every decision:

```ts
interface RiskState {
  position: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  dailyHighWatermarkUsd: number;
  openOrders: number;
}

function approveOrder(
  decision: StrategyDecision,
  features: Features,
  risk: RiskState,
): string | null {
  if (decision.action === "hold") return "strategy selected hold";
  if (features.spreadBps > 10) return "spread too wide";
  if (risk.openOrders > 0) return "previous order still open";

  const pnl = risk.realizedPnlUsd + risk.unrealizedPnlUsd;
  const drawdown = risk.dailyHighWatermarkUsd - pnl;

  if (drawdown > 25) return "daily drawdown limit reached";

  const proposed =
    risk.position + (decision.action === "buy" ? 1 : -1);

  if (Math.abs(proposed) > features.maxPosition) {
    return "position limit reached";
  }

  return null;
}
```

Important invariant: if the requested side is blocked, **hold**. Never silently reverse a buy into a sell.

Controls to evaluate before production use (not all implemented):

- Maximum order notional.
- Maximum total exposure.
- Daily loss limit.
- Consecutive-loss circuit breaker.
- Stale market-data cutoff.
- Maximum decision latency.
- Maximum order age.
- Duplicate-order prevention.
- Exchange position reconciliation.
- Manual kill switch.
- Jev failure or timeout → hold.

## Paper execution must model realistic fills

A paper bot should not assume every order fills at the requested price.

For maker orders:

1. Record the submitted price and queue time.
2. Wait until a later trade crosses that price.
3. Cap the simulated fill by observed traded volume.
4. Apply maker fees or rebates.
5. Measure price movement after the fill.
6. Cancel or expire the order exactly as live execution would.

For taker orders:

1. Walk the available order-book depth.
2. Include taker fees.
3. Include latency between snapshot and execution.
4. Reject fills when the book has moved.

Avoid candle-only backtests for an order-book strategy. Candles do not provide enough information to simulate queue position or maker fills.

## Record every decision

Paper replay uses append-only JSONL; Testnet uses the SQLite audit table described
in the operator guide. The following is a proposed combined record, not the exact
schema of either current output:

```json
{
  "timestamp": 1789593630676,
  "model": "jev-1.13.0",
  "state": {},
  "answers": {},
  "latencyMs": 112,
  "decision": "hold",
  "gateReason": "direction probability below threshold",
  "order": null,
  "futureMid": null,
  "fill": null,
  "pnl": null
}
```

Later, attach outcomes after the forecast horizon:

- Future mid-price.
- Return in basis points.
- Return after spread and fees.
- Whether the direction was correct.
- Whether the order filled.
- Post-fill adverse movement.
- Realized and mark-to-market P&L.

Store the complete probabilities, not only the chosen option.

## Validate the model before trading

Evaluate Jev against simple baselines:

- Always hold.
- Random buy/sell.
- Last-return momentum.
- Order-book imbalance threshold.
- Taker-flow threshold.
- Logistic regression over the same features.

Measure:

- Net P&L after all costs.
- Maximum drawdown.
- Sharpe or Sortino ratio.
- Turnover.
- Fill rate.
- Adverse selection after fills.
- Brier score and log loss for probabilities.
- Calibration by probability bucket.
- Latency and missed-decision rate.
- Performance by market regime.

Use chronological walk-forward evaluation:

```text
train/tune thresholds → validation → untouched future test period
```

Never randomly shuffle time-series samples. That leaks future market regimes into the past.

## Safe implementation order

1. **Recorder:** Collect order-book and trade events without making decisions.
2. **Feature engine:** Calculate deterministic features and future outcome labels.
3. **Jev shadow mode:** Query Jev and log answers without trading.
4. **Replay harness:** Evaluate thresholds and compare with simple baselines.
5. **Paper trading:** Simulate actual order behavior and costs.
6. **Testnet:** Validate placement, partial fills, cancellation, restart recovery,
   and kill switches using virtual assets and manual supervision.
7. **Production readiness review:** Require exchange integration validation,
   monitoring, and positive out-of-sample net expectancy before separately
   implementing and authorizing any real-money execution.
8. **Scale only from observed net expectancy:** Do not scale from classification accuracy.

JevFlow now has the single-market paper/replay foundation and an experimental
Testnet adapter. Evaluation and authenticated Testnet validation are still
outstanding. Testnet development is execution testing, not evidence of trading
edge or permission to add real funds.

## Sources

- [TypeSafe: How to build with System One](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- [Jev question primitives](https://docs.typesafe.ai/primitives)
- [Confidence semantics](https://docs.typesafe.ai/confidence)
- [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [Model limits and version aliases](https://docs.typesafe.ai/models)
- [Reference Jev trader](https://github.com/jarrodwatts/jev-trader)
