import { z } from "zod";
import { predictionSchema, type Features, type Predictor } from "./types";

export const MODEL = "jev-1.13.0";
export const TIMEOUT_MS = 1_000;

export function jevState(features: Features) {
  return {
    horizonSeconds: 60,
    execution: "Long-only spot. Buy posts at best bid; sell posts at best ask. Maker orders may not fill and expire after 15 seconds. Hold places no order.",
    features,
    marketState: {
      momentum: features.returnBps > 3 ? "up" : features.returnBps < -3 ? "down" : "flat",
      bookPressure: features.bookImbalance > 0.2 ? "bid-heavy" : features.bookImbalance < -0.2 ? "ask-heavy" : "balanced",
      takerFlow: features.flowImbalance > 0.2 ? "buyers-aggressive" : features.flowImbalance < -0.2 ? "sellers-aggressive" : "mixed",
    },
  };
}

export function createJevPredictor(apiKey: string, request: typeof fetch = fetch): Predictor {
  if (!apiKey.trim()) throw new Error("TYPESAFE_API_KEY is required with --jev");
  return async (features) => {
    const started = performance.now();
    const response = await request("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL,
        state: jevState(features),
        questions: {
          direction: {
            type: "choice",
            instructions: "Which action fits the expected direction over the next 60 seconds? Use the precomputed features and marketState. Execution is post-only maker, not immediate taker. Choose hold when evidence is weak, contradictory, or insufficient. These probabilities are action judgments, not probabilities of profitable fills.",
            criteria: {
              buy: "Consistent evidence of upward price pressure.",
              sell: "Consistent evidence of downward price pressure.",
              hold: "Insufficient, conflicting, or unstable directional evidence.",
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
    const result = z.object({
      model: z.string(),
      answers: z.object({ direction: predictionSchema }),
    }).parse(await response.json());
    return { model: result.model, prediction: result.answers.direction, latencyMs: performance.now() - started };
  };
}

// An uncalibrated smoke-test baseline, never presented as Jev predictions.
export const imbalanceBaseline: Predictor = async (features) => {
  const choice = features.bookImbalance > 0.2 ? "buy" : features.bookImbalance < -0.2 ? "sell" : "hold";
  const probabilities = { buy: 0.1, sell: 0.1, hold: 0.1 };
  probabilities[choice] = 0.8;
  return { model: "uncalibrated-imbalance-baseline", latencyMs: 0,
    prediction: { type: "choice", choice, probabilities, confidence: 0.7 } };
};
