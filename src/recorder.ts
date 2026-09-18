import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { eventSchema, type MarketEvent } from "./types";

export const KRAKEN_SYMBOL = "BTC/CHF";
export const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";
const MAX_DATA_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const positive = z.number().finite().positive();
const timestamp = z.string().datetime({ offset: true });
const tickerSchema = z.object({
  channel: z.literal("ticker"), type: z.enum(["snapshot", "update"]),
  data: z.array(z.object({ symbol: z.string(), bid: positive, bid_qty: positive,
    ask: positive, ask_qty: positive, timestamp })).length(1),
});
const tradeSchema = z.object({
  channel: z.literal("trade"), type: z.enum(["snapshot", "update"]),
  data: z.array(z.object({ symbol: z.string(), side: z.enum(["buy", "sell"]),
    price: positive, qty: positive, ord_type: z.enum(["limit", "market"]),
    trade_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), timestamp })).min(1),
});
const ackSchema = z.object({ method: z.literal("subscribe"), success: z.boolean(),
  error: z.string().optional(), req_id: z.number().int(), result: z.object({
    channel: z.enum(["ticker", "trade"]), symbol: z.string(), snapshot: z.boolean(),
  }).optional(),
});

export function validateSymbol(symbol: string) {
  if (symbol !== KRAKEN_SYMBOL) throw new Error(`Only Kraken Spot ${KRAKEN_SYMBOL} is supported`);
  return symbol;
}

export type NormalizedResult = { events: MarketEvent[]; status: string };

/** One connection = one replay segment. Dedupe state is deliberately not carried over outages. */
export class KrakenNormalizer {
  private timestampMs = -1;
  private hasBook = false;
  private lastBookReceived: number | undefined;
  private readonly tradeIds = new Set<number>();
  private readonly acknowledgements = new Set<string>();

  constructor(readonly symbol: string) { validateSymbol(symbol); }

  accept(payload: unknown, receivedAtMs: number): NormalizedResult {
    if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < this.timestampMs) throw new Error("Receive clock moved backwards");
    this.timestampMs = receivedAtMs;
    if (typeof payload !== "object" || payload === null) throw new Error("Malformed Kraken payload");
    const value = payload as Record<string, unknown>;
    if (value.channel === "heartbeat") {
      z.object({ channel: z.literal("heartbeat") }).parse(payload);
      return { events: [], status: "heartbeat" };
    }
    // Kraken emits this administrative message automatically on connection/state changes.
    if (value.channel === "status") {
      const status = z.object({ channel: z.literal("status"), type: z.literal("update"), data: z.array(z.object({
        system: z.enum(["online", "maintenance", "cancel_only", "post_only"]),
        api_version: z.literal("v2"),
      })).length(1) }).parse(payload);
      // connection_id is an opaque uint64, not a safe JS integer. Raw JSON preserves it.
      if (status.data[0].system !== "online") throw new Error("Kraken market is not online");
      return { events: [], status: "exchange status" };
    }
    if (value.method === "subscribe") {
      const ack = ackSchema.parse(payload);
      if (!ack.success) throw new Error(`Kraken subscription failed: ${ack.error ?? "unknown error"}`);
      if (!ack.result || ack.result.symbol !== this.symbol) throw new Error("Subscription symbol mismatch");
      const expectedId = ack.result.channel === "ticker" ? 1 : 2;
      const expectedSnapshot = ack.result.channel === "ticker";
      if (ack.req_id !== expectedId || ack.result.snapshot !== expectedSnapshot) throw new Error("Unexpected subscription acknowledgement");
      if (this.acknowledgements.has(ack.result.channel)) throw new Error("Duplicate subscription acknowledgement");
      this.acknowledgements.add(ack.result.channel);
      return { events: [], status: `${ack.result.channel} subscribed` };
    }
    if (value.channel === "ticker") {
      const message = tickerSchema.parse(payload);
      if (!this.acknowledgements.has("ticker")) throw new Error("Ticker data before subscription acknowledgement");
      const quote = message.data[0];
      this.validateData(quote.symbol, quote.timestamp, receivedAtMs);
      if (quote.bid >= quote.ask) throw new Error("Crossed Kraken top of book");
      const event = eventSchema.parse({ type: "book", market: this.symbol, timestampMs: receivedAtMs,
        bid: quote.bid, bidSize: quote.bid_qty, ask: quote.ask, askSize: quote.ask_qty });
      this.hasBook = true;
      this.lastBookReceived = receivedAtMs;
      return { events: [event], status: "book" };
    }
    if (value.channel === "trade") {
      const message = tradeSchema.parse(payload);
      if (!this.acknowledgements.has("trade")) throw new Error("Trade data before subscription acknowledgement");
      // A trade snapshot is the previous 50 trades. It must never enter a live recording.
      if (message.type !== "update") throw new Error("Historical trade snapshot received");
      const events: MarketEvent[] = [];
      for (const trade of message.data) {
        this.validateData(trade.symbol, trade.timestamp, receivedAtMs);
        // Kraken documents uniqueness per book, but not gap-free delivery semantics here.
        if (this.tradeIds.has(trade.trade_id)) continue;
        this.tradeIds.add(trade.trade_id);
        if (!this.hasBook) continue;
        if (this.lastBookReceived === undefined || receivedAtMs - this.lastBookReceived > MAX_DATA_AGE_MS) throw new Error("Stale book before trade");
        events.push(eventSchema.parse({ type: "trade", market: this.symbol, timestampMs: receivedAtMs,
          price: trade.price, size: trade.qty, side: trade.side }));
      }
      return { events, status: events.length ? "trade" : "duplicate or waiting for first book" };
    }
    throw new Error("Unexpected Kraken message");
  }

  private validateData(symbol: string, exchangeTimestamp: string, receivedAtMs: number) {
    if (symbol !== this.symbol) throw new Error("Kraken data symbol mismatch");
    const exchangeMs = Date.parse(exchangeTimestamp);
    if (!Number.isFinite(exchangeMs) || exchangeMs < receivedAtMs - MAX_DATA_AGE_MS || exchangeMs > receivedAtMs + MAX_FUTURE_SKEW_MS) {
      throw new Error("Stale or future-dated Kraken data");
    }
  }
}

export interface RecorderOptions {
  symbol: string; directory: string; durationMs: number; signal?: AbortSignal;
  connect?: (url: string) => WebSocket;
}

export async function recordMarket(options: RecorderOptions) {
  const { symbol, directory, durationMs, signal } = options;
  validateSymbol(symbol);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86_400_000) throw new Error("Duration must be between 0 and 86400 seconds");
  mkdirSync(directory, { recursive: false });
  const raw = openSync(join(directory, "raw.jsonl"), "wx", 0o600);
  const writeRaw = (record: Record<string, unknown>) => writeSync(raw, JSON.stringify(record) + "\n");
  const started = performance.now();
  const summary = { symbol, segments: 0, messages: 0, events: 0, duplicates: 0, interruptions: 0 };
  let stopping = signal?.aborted ?? false;
  let stopConnection: (() => void) | undefined;
  const stop = () => { stopping = true; stopConnection?.(); };
  signal?.addEventListener("abort", stop, { once: true });
  const deadline = setTimeout(stop, durationMs);
  let failures = 0;
  try {
    writeRaw({ type: "session", symbol, timestampMs: Date.now(), clock: "local receive time", url: KRAKEN_WS_URL,
      subscriptions: ["ticker:event_trigger=bbo:snapshot=true", "trade:snapshot=false"] });
    while (!stopping) {
      const segment = ++summary.segments;
      const fd = openSync(join(directory, `events-${String(segment).padStart(4, "0")}.jsonl`), "wx", 0o600);
      const normalizer = new KrakenNormalizer(symbol);
      let count = 0;
      let error: unknown;
      let reason = "connection closed";
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = (options.connect ?? ((endpoint) => new WebSocket(endpoint)))(KRAKEN_WS_URL);
          let done = false;
          let lastMarketData = performance.now();
          const finish = (why: string, fatal?: unknown) => {
            if (done) return;
            done = true; reason = why; clearInterval(watchdog); stopConnection = undefined; socket.close();
            if (fatal) reject(fatal); else resolve();
          };
          const watchdog = setInterval(() => {
            if (performance.now() - lastMarketData > MAX_DATA_AGE_MS) finish("market data timeout");
          }, 1_000);
          stopConnection = () => finish("stopped");
          socket.onopen = () => {
            socket.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: [symbol], event_trigger: "bbo", snapshot: true }, req_id: 1 }));
            socket.send(JSON.stringify({ method: "subscribe", params: { channel: "trade", symbol: [symbol], snapshot: false }, req_id: 2 }));
          };
          socket.onmessage = (message) => {
            if (done) return;
            const receivedAtMs = Date.now();
            try {
              writeRaw({ type: "message", segment, receivedAtMs, payload: String(message.data) });
              summary.messages++;
              let result: NormalizedResult;
              try { result = normalizer.accept(JSON.parse(String(message.data)), receivedAtMs); }
              catch { finish("invalid, stale, or unexpected Kraken data"); return; }
              if (result.status === "book" || result.status === "trade") lastMarketData = performance.now();
              if (result.status === "duplicate or waiting for first book") summary.duplicates++;
              for (const event of result.events) { writeSync(fd, JSON.stringify(event) + "\n"); summary.events++; count++; }
            } catch (failure) { finish("recording write failed", failure); }
          };
          socket.onclose = () => finish("connection closed");
          socket.onerror = () => finish("connection error");
        });
      } catch (failure) { error = failure; }
      finally { closeSync(fd); }
      writeRaw({ type: "segment-end", segment, timestampMs: Date.now(), events: count, reason });
      if (error) throw error;
      if (stopping) break;
      summary.interruptions++;
      failures = count > 0 ? 1 : failures + 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
      const remaining = durationMs - (performance.now() - started);
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(delay, remaining));
        stopConnection = () => { clearTimeout(timer); resolve(); };
      });
      stopConnection = undefined;
    }
    writeRaw({ type: "summary", timestampMs: Date.now(), ...summary });
    return summary;
  } finally {
    clearTimeout(deadline); signal?.removeEventListener("abort", stop); closeSync(raw);
  }
}
