import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KrakenNormalizer, recordMarket } from "./recorder";

const symbol = "BTC/CHF";
const iso = (ms: number) => new Date(ms).toISOString();
const ack = (channel: "ticker" | "trade") => ({ method: "subscribe", success: true,
  req_id: channel === "ticker" ? 1 : 2, result: { channel, symbol, snapshot: channel === "ticker" } });
const book = (ms: number, type: "snapshot" | "update" = "update") => ({ channel: "ticker", type, data: [{
  symbol, bid: 50_000, bid_qty: 1.2, ask: 50_001, ask_qty: 0.8, timestamp: iso(ms),
}] });
const trades = (ms: number, ids = [40], type: "snapshot" | "update" = "update") => ({ channel: "trade", type,
  data: ids.map((trade_id, i) => ({ symbol, side: i % 2 ? "buy" : "sell", price: 50_000.5,
    qty: 0.1, ord_type: "limit", trade_id, timestamp: iso(ms) })) });
const ready = (feed: KrakenNormalizer) => { feed.accept(ack("ticker"), 1_000); feed.accept(ack("trade"), 1_000); };

test("accepts real status with opaque uint64 connection ID and stops for maintenance", () => {
  const feed = new KrakenNormalizer(symbol);
  const status = JSON.parse('{"channel":"status","type":"update","data":[{"system":"online","api_version":"v2","connection_id":10504484002566990987}]}');
  expect(feed.accept(status, 0).events).toEqual([]);
  status.data[0].system = "maintenance";
  expect(() => feed.accept(status, 1)).toThrow("not online");
});

test("normalizes Kraken BBO and batched trades in receipt order without requiring consecutive IDs", () => {
  const feed = new KrakenNormalizer(symbol); ready(feed);
  expect(feed.accept(book(1_000), 1_000).events[0]).toEqual({ type: "book", market: symbol,
    timestampMs: 1_000, bid: 50_000, ask: 50_001, bidSize: 1.2, askSize: 0.8 });
  const result = feed.accept(trades(1_001, [40, 99]), 1_001);
  expect(result.events.map((event) => event.type === "trade" && event.side)).toEqual(["sell", "buy"]);
  expect(result.events.every((event) => event.timestampMs === 1_001)).toBeTrue();
  expect(feed.accept(trades(1_002, [99]), 1_002).events).toEqual([]);
});

test("rejects historical snapshots, stale/malformed/crossed/wrong-symbol data and bad acknowledgements", () => {
  const feed = new KrakenNormalizer(symbol); ready(feed); feed.accept(book(100_000), 100_000);
  expect(() => feed.accept(trades(100_001, [1], "snapshot"), 100_001)).toThrow("Historical");
  expect(() => feed.accept(book(1), 100_002)).toThrow("Stale");
  expect(() => feed.accept({ ...book(100_003), data: [{ ...book(100_003).data[0], ask: 49_999 }] }, 100_003)).toThrow("Crossed");
  expect(() => feed.accept({ channel: "wat" }, 100_004)).toThrow("Unexpected");
  const wrong = book(100_005); wrong.data[0].symbol = "ETH/CHF";
  expect(() => feed.accept(wrong, 100_005)).toThrow("symbol");
  expect(() => new KrakenNormalizer(symbol).accept({ ...ack("trade"), success: false, error: "unsupported" }, 0)).toThrow("failed");
  expect(() => new KrakenNormalizer("BTC/USD")).toThrow("Only Kraken");
});

test("local WebSocket subscribes correctly, segments reconnects, and preserves raw evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "jevflow-recorder-"));
  const directory = join(root, "session");
  let connections = 0;
  const subscriptions: unknown[] = [];
  const server = Bun.serve({ port: 0, fetch(request, server) {
    if (server.upgrade(request)) return; return new Response("websocket required", { status: 400 });
  }, websocket: {
    open() { connections++; },
    message(socket, message) {
      const request = JSON.parse(String(message)); subscriptions.push(request);
      socket.send(JSON.stringify(ack(request.params.channel)));
      if (request.params.channel === "trade") {
        const now = Date.now(); socket.send(JSON.stringify(book(now))); socket.send(JSON.stringify(trades(now, [connections * 10])));
        if (connections === 1) socket.send(JSON.stringify({ channel: "bad" }));
      }
    },
  } });
  try {
    const summary = await recordMarket({ symbol, directory, durationMs: 1_500,
      connect: () => new WebSocket(`ws://127.0.0.1:${server.port}`) });
    expect(summary).toMatchObject({ segments: 2, events: 4, interruptions: 1 });
    expect(subscriptions.slice(0, 2)).toEqual([
      { method: "subscribe", params: { channel: "ticker", symbol: [symbol], event_trigger: "bbo", snapshot: true }, req_id: 1 },
      { method: "subscribe", params: { channel: "trade", symbol: [symbol], snapshot: false }, req_id: 2 },
    ]);
    const raw = readFileSync(join(directory, "raw.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(raw.find((row) => row.type === "segment-end").reason).toContain("Kraken");
    for (const name of ["events-0001.jsonl", "events-0002.jsonl"]) {
      expect(readFileSync(join(directory, name), "utf8").trim().split("\n")).toHaveLength(2);
    }
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("abort stops before connecting", async () => {
  const root = mkdtempSync(join(tmpdir(), "jevflow-abort-")); const controller = new AbortController(); controller.abort();
  try {
    const result = await recordMarket({ symbol, directory: join(root, "session"), durationMs: 60_000,
      signal: controller.signal, connect: () => { throw new Error("Must not connect"); } });
    expect(result.segments).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
