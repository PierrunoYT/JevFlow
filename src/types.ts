import { z } from "zod";

const positive = z.number().finite().positive();
export const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("book"),
    market: z.string().min(1),
    timestampMs: z.number().int().nonnegative(),
    bid: positive,
    ask: positive,
    bidSize: positive,
    askSize: positive,
  }).strict().refine((book) => book.ask > book.bid, "Book must not be crossed or locked"),
  z.object({
    type: z.literal("trade"),
    market: z.string().min(1),
    timestampMs: z.number().int().nonnegative(),
    price: positive,
    size: positive,
    // The aggressor's side, not the maker's side.
    side: z.enum(["buy", "sell"]),
  }).strict(),
]);
export type MarketEvent = z.infer<typeof eventSchema>;
export type Book = Extract<MarketEvent, { type: "book" }>;
export type Trade = Extract<MarketEvent, { type: "trade" }>;
export type Action = "buy" | "sell" | "hold";

const probability = z.number().finite().min(0).max(1);
export const predictionSchema = z.object({
  type: z.literal("choice"),
  choice: z.enum(["buy", "sell", "hold"]),
  probabilities: z.object({ buy: probability, sell: probability, hold: probability }).strict(),
  confidence: probability,
}).refine((p) => Math.abs(Object.values(p.probabilities).reduce((a, b) => a + b, 0) - 1) < 0.0001,
  "Probabilities must sum to one")
  .refine((p) => p.probabilities[p.choice] >= Math.max(...Object.values(p.probabilities)),
    "Choice must have highest probability");
export type Prediction = z.infer<typeof predictionSchema>;

export interface Features {
  market: string;
  timestampMs: number;
  mid: number;
  spreadBps: number;
  returnBps: number;
  bookImbalance: number;
  flowImbalance: number;
  observations: number;
}

export interface Evaluation {
  model: string;
  prediction: Prediction;
  latencyMs: number;
}
export type Predictor = (features: Features) => Promise<Evaluation>;
