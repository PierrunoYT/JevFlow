import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { eventSchema, type MarketEvent } from "./types";

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().regex(/^\d+(\.\d+)?$/).transform(Number).pipe(z.number().finite().positive());
const level = z.tuple([decimal, decimal]);
const snapshotSchema = z.object({ lastUpdateId: id, bids: z.array(level).min(1).max(5), asks: z.array(level).min(1).max(5) });
const tradeSchema = z.object({ e: z.literal("trade"), s: z.string(), t: id, p: decimal, q: decimal, T: id, m: z.boolean() });
const envelopeSchema = z.object({ stream: z.string(), data: z.unknown() });

export function validateSymbol(symbol: string) {
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error("Use a Binance spot symbol such as BTCUSDT");
  return symbol;
}

/** One connection = one replay segment. Never carry cursors across an outage. */
export class BinanceNormalizer {
  private bookId = -1;
  private tradeId: number | undefined;
  private timestampMs = -1;
  private lastBookReceived: number | undefined;
  private lastTradeTime = -1;

  constructor(readonly symbol: string) { validateSymbol(symbol); }

  accept(payload: unknown, receivedAtMs: number): { event: MarketEvent | null; status: string } {
    if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < this.timestampMs) throw new Error("Receive clock moved backwards");
    this.timestampMs = receivedAtMs;
    const message = envelopeSchema.parse(payload);
    if (message.stream === `${this.symbol.toLowerCase()}@depth5@100ms`) {
      if (this.lastBookReceived !== undefined && receivedAtMs - this.lastBookReceived > 1_000) throw new Error("Book observation gap");
      const book = snapshotSchema.parse(message.data);
      if (book.lastUpdateId < this.bookId) throw new Error("Book update ID regressed");
      // Equal IDs are fresh repeated full snapshots, not missing book updates.
      for (const [levels, sign] of [[book.bids, -1], [book.asks, 1]] as const) {
        for (let i = 1; i < levels.length; i++) {
          if ((levels[i][0] - levels[i - 1][0]) * sign <= 0) throw new Error("Book levels are not strictly ordered");
        }
      }
      const event = eventSchema.parse({ type: "book", market: this.symbol, timestampMs: receivedAtMs,
        bid: book.bids[0][0], bidSize: book.bids[0][1], ask: book.asks[0][0], askSize: book.asks[0][1] });
      this.bookId = book.lastUpdateId;
      this.lastBookReceived = receivedAtMs;
      return { event, status: "book" };
    }
    if (message.stream !== `${this.symbol.toLowerCase()}@trade`) throw new Error("Unexpected stream");
    const trade = tradeSchema.parse(message.data);
    if (trade.s !== this.symbol) throw new Error("Trade symbol mismatch");
    if (this.tradeId !== undefined) {
      if (trade.t === this.tradeId) return { event: null, status: "duplicate trade" };
      if (trade.t !== this.tradeId + 1) throw new Error("Trade ID gap or regression");
    }
    if (trade.T < this.lastTradeTime) throw new Error("Trade exchange time regressed");
    this.tradeId = trade.t;
    this.lastTradeTime = trade.T;
    if (this.lastBookReceived === undefined) return { event: null, status: "waiting for first book" };
    if (receivedAtMs - this.lastBookReceived > 1_000) throw new Error("Stale book before trade");
    // Binance m=true means buyer is maker, so the aggressor is selling.
    const event = eventSchema.parse({ type: "trade", market: this.symbol, timestampMs: receivedAtMs,
      price: trade.p, size: trade.q, side: trade.m ? "sell" : "buy" });
    return { event, status: "trade" };
  }
}

export interface RecorderOptions {
  symbol: string;
  directory: string;
  durationMs: number;
  signal?: AbortSignal;
  // Dependency injection for local transport tests; CLI always uses public market data.
  connect?: (url: string) => WebSocket;
}

export async function recordMarket(options: RecorderOptions) {
  const { symbol, directory, durationMs, signal } = options;
  validateSymbol(symbol);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86_400_000) throw new Error("Duration must be between 0 and 86400 seconds");
  // Refuse an existing directory, including an earlier incomplete session.
  mkdirSync(directory, { recursive: false });
  const raw = openSync(join(directory, "raw.jsonl"), "wx", 0o600);
  const writeRaw = (record: Record<string, unknown>) => writeSync(raw, JSON.stringify(record) + "\n");
  const url = `wss://data-stream.binance.vision/stream?streams=${symbol.toLowerCase()}@depth5@100ms/${symbol.toLowerCase()}@trade`;
  const started = performance.now();
  const summary = { symbol, segments: 0, messages: 0, events: 0, duplicates: 0, interruptions: 0 };
  let stopping = signal?.aborted ?? false;
  let stopConnection: (() => void) | undefined;
  const stop = () => { stopping = true; stopConnection?.(); };
  signal?.addEventListener("abort", stop, { once: true });
  const deadline = setTimeout(stop, durationMs);
  let failures = 0;
  try {
    writeRaw({ type: "session", symbol, timestampMs: Date.now(), clock: "local receive time", url });
    while (!stopping) {
      const segment = ++summary.segments;
      const fd = openSync(join(directory, `events-${String(segment).padStart(4, "0")}.jsonl`), "wx", 0o600);
      const normalizer = new BinanceNormalizer(symbol);
      let count = 0;
      let error: unknown;
      let reason = "connection closed";
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = (options.connect ?? ((endpoint) => new WebSocket(endpoint)))(url);
          let done = false;
          let lastBook = performance.now();
          const finish = (why: string, fatal?: unknown) => {
            if (done) return;
            done = true;
            reason = why;
            clearInterval(watchdog);
            stopConnection = undefined;
            socket.close();
            if (fatal) reject(fatal); else resolve();
          };
          const watchdog = setInterval(() => {
            if (performance.now() - lastBook > 10_000) finish("book timeout");
          }, 1_000);
          stopConnection = () => finish("stopped");
          socket.onmessage = (message) => {
            if (done) return;
            const receivedAtMs = Date.now();
            try {
              // Keep the exact payload and receive time even if validation fails.
              writeRaw({ type: "message", segment, receivedAtMs, payload: String(message.data) });
              summary.messages++;
              let result;
              try { result = normalizer.accept(JSON.parse(String(message.data)), receivedAtMs); }
              catch { finish("invalid data, sequence gap, or stale book"); return; }
              if (result.status === "book") lastBook = performance.now();
              if (result.status === "duplicate trade") summary.duplicates++;
              if (result.event) {
                writeSync(fd, JSON.stringify(result.event) + "\n");
                summary.events++;
                count++;
              }
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
    clearTimeout(deadline);
    signal?.removeEventListener("abort", stop);
    closeSync(raw);
  }
}
