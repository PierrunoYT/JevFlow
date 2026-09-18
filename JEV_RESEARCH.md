# How TypeSafe AI's Jev Works

## Overview

Jev is **not a chat model** and does not generate text. It is TypeSafe AI's first "System One" model:

```text
structured/unstructured state
        +
typed questions with predefined answers
        ↓
typed decisions + probability distributions
```

It is effectively a fast, probabilistic decision function embedded inside normal software. Code remains responsible for control flow, arithmetic, validation, side effects, and risk management.

## Request model

A request sends one shared `state` and one or more independent questions:

```json
{
  "model": "jev-latest",
  "state": {
    "message": "My card was charged twice"
  },
  "questions": {
    "refund_request": {
      "type": "noul",
      "instructions": "Does the customer request a refund?"
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, charges, or refunds",
        "technical": "Bugs or integration problems"
      }
    }
  }
}
```

The response is constrained to the declared types:

```json
{
  "answers": {
    "refund_request": {
      "type": "noul",
      "noul": 0.87
    },
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {
        "billing": 0.96,
        "technical": 0.04
      },
      "confidence": 0.91
    }
  }
}
```

The three primitives are:

- **Choice:** Selects one predefined option and returns every option's probability.
- **Score:** Evaluates ordered descriptive levels and returns their probability-weighted position.
- **Noul:** Makes a yes/no judgment and returns the probability of yes directly.

Questions sharing a state run independently and in parallel. A question cannot consume another question's answer in the same request.

## Why it is fast

Unlike an autoregressive LLM, Jev does not emit tokens sequentially. Its specialized sampler produces the requested distributions in parallel.

TypeSafe currently reports:

- Typical latency: approximately **70–500 ms**, often around 100 ms.
- Price: **$0.042 per million input tokens**.
- Output tokens: not billed.
- Current model: `jev-1.13.0`; aliases include `jev-latest`.
- Context: 64k combined request budget, with 32k for state plus the longest question.
- Choice cardinality: up to 255 options.
- Training objective: **Reinforcement Learning for Calibrated Decisions**, or RLCD.

"Calibrated" means that, across a sufficiently representative collection of predictions, outcomes receiving probability 0.8 should occur about 80% of the time. It does **not** guarantee any individual prediction or guarantee calibration on a new trading distribution.

## How the reference trading bot uses Jev

The open-source [`jarrodwatts/jev-trader`](https://github.com/jarrodwatts/jev-trader) calls Jev through Vercel's AI SDK:

```ts
import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";

const result = await experimental_evaluate({
  model: typeSafeAi.evaluationModel("jev-latest"),
  state,
  questions: {
    direction: {
      type: "choice",
      instructions: {
        question:
          "Will MON be higher or lower than the current mid after `horizonBlocks` more blocks?",
        // additional trading context
      },
      criteria: {
        buy: "Buy MON now: price likely to rise by more than the spread.",
        sell: "Sell MON now: price likely to fall by more than the spread."
      }
    }
  },
  maxRetries: 0
});
```

Every Monad block, the bot builds a compact state containing:

- Current mid-price and spread.
- Bid/ask depth at several distance bands.
- Top five order-book levels.
- Book imbalance.
- Returns over 1, 5, 20, and 100 blocks.
- Recent sampled mid-prices.
- Taker buy/sell volume and cumulative volume delta.
- Recent trades.
- Whether position limits permit buying or selling.

Jev returns a bounded decision such as:

```ts
{
  choice: "buy",
  probabilities: {
    buy: 0.77,
    sell: 0.23
  }
}
```

The surrounding code—not Jev—then:

1. Enforces inventory and available-funds limits.
2. Chooses the permitted order side.
3. Cancels the prior resting order.
4. Posts a new post-only limit order.
5. Tracks receipts, fills, inventory, gas, and P&L.
6. Emits dashboard events.

Jev only performs the directional classification. It does not access the chain, construct orders, manage keys, or calculate P&L.

## Problems in the reference trader

### 1. No genuine hold decision

Jev can only return `buy` or `sell`. `hold` is emitted only when inference misses the block. The bot therefore trades even when probabilities are nearly 50/50.

### 2. No confidence or edge gate

The trader ignores the Choice `confidence` field. It does not require expected price movement to exceed spread, gas, slippage, adverse-selection risk, and model error.

### 3. The prompt contradicts execution

The Jev question says the trade "crosses the spread" and executes as an immediate-or-cancel market order. The implementation actually submits a **post-only maker limit order inside the touch**. These have materially different fill probabilities, costs, and adverse-selection behavior.

### 4. Risk limits can reverse the prediction

If Jev says buy but the buy side is capped, code can submit a sell instead. It then mutates `decision.action` to sell while retaining Jev's original probabilities. That makes decision telemetry semantically inconsistent.

### 5. Misleading probability name

`upIn10` is assigned the buy probability, although the default forecast horizon is 100 blocks, approximately 30 seconds.

### 6. The task hits Jev's documented weak spots

TypeSafe explicitly says Jev 1.13 is weak at numeric precision, arithmetic, date/time comparisons, indirection, and large irrelevant states. Very short-horizon price prediction is dominated by numeric relationships and timing.

### 7. Calibration does not establish trading alpha

Even perfectly calibrated direction probabilities can lose money after spread, fees, gas, missed fills, and adverse selection.

## Appropriate architecture for JevFlow

Jev is potentially useful as one component, not as the trading system:

```text
market feed
    ↓
deterministic feature computation
    ↓
Jev: classify regime/direction/risk
    ↓
probability and confidence gate
    ↓
deterministic position sizing and risk limits
    ↓
execution engine
```

Potential narrow Jev judgments include:

- `direction`: buy / sell / neutral.
- `market_regime`: trending / reverting / dislocated / unclear.
- `flow_quality`: persistent / noisy / contradictory.
- `adverse_selection_risk`: low / medium / high.
- `should_quote`: a Noul whose probability must clear a tested threshold.

Arithmetic should remain in code:

- Returns and volatility.
- Order-book imbalance.
- Expected value after costs.
- Position sizing.
- Exposure limits.
- Drawdown and kill switches.
- Staleness and timing checks.

For JevFlow, the safest first milestone is a replay/backtest harness that logs the complete probability distribution against future returns and actual executable fills. It should demonstrate out-of-sample net expectancy before any live private key is introduced.

## Sources

### Official TypeSafe sources

- [TypeSafe documentation index](https://docs.typesafe.ai/llms.txt)
- [System One concept](https://docs.typesafe.ai/concepts/system-one)
- [State design](https://docs.typesafe.ai/concepts/state)
- [Question primitives](https://docs.typesafe.ai/primitives)
- [Choice primitive](https://docs.typesafe.ai/primitives/choice)
- [Score primitive](https://docs.typesafe.ai/primitives/score)
- [Noul primitive](https://docs.typesafe.ai/primitives/noul)
- [Confidence semantics](https://docs.typesafe.ai/confidence)
- [Quick start and API examples](https://docs.typesafe.ai/introduction/quickstart)
- [HTTP API reference](https://docs.typesafe.ai/api)
- [Current Jev models, limits, pricing, and aliases](https://docs.typesafe.ai/models)
- [Jev 1.13 known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [How to build with System One](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- [RLCD and calibrated decisions](https://docs.typesafe.ai/introduction/machine-learning-primer)
- [Speculative fan-out pattern](https://docs.typesafe.ai/patterns/fan-out)
- [Trading-oriented function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling)
- [Introducing System One Models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

### Reference implementations and integrations

- [`jarrodwatts/jev-trader`](https://github.com/jarrodwatts/jev-trader)
- [`jev-trader/src/model.ts`](https://github.com/jarrodwatts/jev-trader/blob/main/src/model.ts)
- [`jev-trader/src/trader.ts`](https://github.com/jarrodwatts/jev-trader/blob/main/src/trader.ts)
- [Vercel AI Gateway model page for Jev](https://vercel.com/ai-gateway/models/jev)
- [LangChain: Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev)
