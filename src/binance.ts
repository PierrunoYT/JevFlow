import { createHmac } from "node:crypto";
import { z } from "zod";

export const TESTNET = "https://testnet.binance.vision";
export const SYMBOL = "BTCUSDT";
export const SCALE = 100_000_000n;

// Execution arithmetic never passes through binary floating point.
export function units(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("Invalid nonnegative decimal");
  const [whole, raw = ""] = value.split(".");
  const fraction = raw.replace(/0+$/, "");
  if (fraction.length > 8) throw new Error("Unsupported precision (maximum 8 decimal places)");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
export function decimal(value: bigint): string {
  if (value < 0n) throw new Error("Negative execution amount");
  return `${value / SCALE}.${(value % SCALE).toString().padStart(8, "0")}`;
}
const amount = z.string().refine((s) => { try { units(s); return true; } catch { return false; } });
const positive = amount.refine((s) => units(s) > 0n);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const orderSchema = z.object({
  symbol: z.literal(SYMBOL), orderId: integer, clientOrderId: z.string(),
  status: z.enum(["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "PENDING_CANCEL", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"]),
  side: z.enum(["BUY", "SELL"]), price: positive, origQty: positive,
  executedQty: amount, cummulativeQuoteQty: amount,
});
export type ExchangeOrder = z.infer<typeof orderSchema>;
export const isTerminal = (order: ExchangeOrder) => ["FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"].includes(order.status);
export const accountSchema = z.object({ canTrade: z.boolean(), balances: z.array(z.object({ asset: z.string(), free: amount, locked: amount })) });
export type Account = z.infer<typeof accountSchema>;
export function balance(account: Account, asset: string) {
  const value = account.balances.find((b) => b.asset === asset);
  return { free: units(value?.free ?? "0"), locked: units(value?.locked ?? "0") };
}
export const tickerSchema = z.object({ symbol: z.literal(SYMBOL), bidPrice: positive, askPrice: positive, bidQty: positive, askQty: positive })
  .refine((b) => units(b.bidPrice) < units(b.askPrice), "Crossed book");
export type Ticker = z.infer<typeof tickerSchema>;
export interface Intent { clientId: string; side: "BUY" | "SELL"; price: string; quantity: string; createdAt: number }
export interface Rules { tick: bigint; step: bigint; minPrice: bigint; maxPrice: bigint; minQty: bigint; maxQty: bigint; minNotional: bigint; maxNotional: bigint }

export function parseRules(value: unknown): Rules {
  const info = z.object({ symbols: z.array(z.object({ symbol: z.string(), status: z.string(), baseAsset: z.string(), quoteAsset: z.string(),
    isSpotTradingAllowed: z.boolean(), orderTypes: z.array(z.string()), filters: z.array(z.record(z.string(), z.unknown())) })) }).parse(value);
  const market = info.symbols.find((s) => s.symbol === SYMBOL);
  if (!market || market.status !== "TRADING" || market.baseAsset !== "BTC" || market.quoteAsset !== "USDT" ||
    !market.isSpotTradingAllowed || !market.orderTypes.includes("LIMIT_MAKER")) throw new Error("BTCUSDT spot maker trading unavailable");
  const price = z.object({ tickSize: positive, minPrice: amount, maxPrice: amount }).parse(market.filters.find((f) => f.filterType === "PRICE_FILTER"));
  const lot = z.object({ stepSize: positive, minQty: positive, maxQty: positive }).parse(market.filters.find((f) => f.filterType === "LOT_SIZE"));
  const notionals = market.filters.filter((f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL");
  if (!notionals.length) throw new Error("Missing notional filter");
  let minNotional = 0n;
  let maxNotional = 0n;
  for (const filter of notionals) {
    const minimum = units(positive.parse(filter.minNotional));
    minNotional = minimum > minNotional ? minimum : minNotional;
    if (filter.filterType === "NOTIONAL") {
      const maximum = units(positive.parse(filter.maxNotional));
      maxNotional = maxNotional === 0n || maximum < maxNotional ? maximum : maxNotional;
    }
  }
  return { tick: units(price.tickSize), step: units(lot.stepSize), minPrice: units(price.minPrice), maxPrice: units(price.maxPrice),
    minQty: units(lot.minQty), maxQty: units(lot.maxQty), minNotional, maxNotional };
}

export function sizeOrder(side: "BUY" | "SELL", book: Ticker, rules: Rules, account: Account) {
  if (!account.canTrade) throw new Error("Account trading disabled");
  const bid = units(book.bidPrice), ask = units(book.askPrice);
  if ((ask - bid) * 20_000n > (ask + bid) * 10n) throw new Error("Spread exceeds 10 bps");
  const touch = side === "BUY" ? bid : ask;
  const price = side === "BUY" ? touch / rules.tick * rules.tick : (touch + rules.tick - 1n) / rules.tick * rules.tick;
  if (!price || price < rules.minPrice || (rules.maxPrice > 0n && price > rules.maxPrice)) throw new Error("Price outside exchange limits");
  const btc = balance(account, "BTC"), usdt = balance(account, "USDT");
  const budget = units("25");
  const available = side === "BUY" ? budget * SCALE / price : (btc.free < budget * SCALE / price ? btc.free : budget * SCALE / price);
  const quantity = available / rules.step * rules.step;
  const notional = price * quantity;
  if (quantity < rules.minQty || quantity > rules.maxQty || notional < rules.minNotional * SCALE ||
    (rules.maxNotional > 0n && notional > rules.maxNotional * SCALE)) throw new Error("Rounded order outside lot/notional limits");
  if (side === "BUY") {
    // Reserve 1% for fees; exchange still enforces its dynamic and account filters.
    if (notional * 101n > usdt.free * SCALE * 100n) throw new Error("Insufficient free quote balance including fee reserve");
    if ((btc.free + btc.locked + quantity) * ask > units("500") * SCALE) throw new Error("BTC exposure would exceed 500 USDT");
  }
  return { price: decimal(price), quantity: decimal(quantity) };
}

export class ExchangeError extends Error {
  constructor(readonly status: number, readonly code: number | undefined) {
    super(`Binance Testnet HTTP ${status}${code === undefined ? "" : ` code ${code}`}`);
  }
}

export class BinanceTestnet {
  private offsetMs = 0;
  private blockedUntil = 0;
  constructor(private key: string, private secret: string,
    private request: (url: string, init: RequestInit) => Promise<Response> = fetch) {}

  private async call(method: string, path: string, values: Record<string, string> = {}, signed = false): Promise<unknown> {
    if (Date.now() < this.blockedUntil) throw new Error("Exchange rate-limit cooldown active");
    const params = new URLSearchParams(values);
    if (signed) {
      if (!this.key || !this.secret) throw new Error("BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET are required");
      params.set("timestamp", String(Math.floor(Date.now() + this.offsetMs)));
      params.set("recvWindow", "5000");
      params.set("signature", createHmac("sha256", this.secret).update(params.toString()).digest("hex"));
    }
    let response: Response;
    try {
      response = await this.request(`${TESTNET}/api/v3/${path}?${params}`, { method,
        headers: signed ? { "X-MBX-APIKEY": this.key } : {}, signal: AbortSignal.timeout(5_000), redirect: "error" });
    } catch { throw new Error("Testnet transport failure; any submitted order has UNKNOWN status"); }
    if (response.status === 429 || response.status === 418) {
      const seconds = Number(response.headers.get("Retry-After"));
      this.blockedUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1_000;
    }
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error("Invalid Testnet response; order status may be UNKNOWN"); }
    if (!response.ok) {
      const error = z.object({ code: z.number() }).safeParse(data);
      throw new ExchangeError(response.status, error.success ? error.data.code : undefined);
    }
    return data;
  }

  async syncTime() {
    const start = Date.now();
    const value = z.object({ serverTime: integer }).parse(await this.call("GET", "time"));
    if (Date.now() - start > 1_000) throw new Error("Clock synchronization request too slow");
    this.offsetMs = value.serverTime - (start + Date.now()) / 2;
  }
  async rules() { return parseRules(await this.call("GET", "exchangeInfo", { symbol: SYMBOL })); }
  async ticker() { return tickerSchema.parse(await this.call("GET", "ticker/bookTicker", { symbol: SYMBOL })); }
  async account() { return accountSchema.parse(await this.call("GET", "account", {}, true)); }
  async openOrders() { return z.array(orderSchema).parse(await this.call("GET", "openOrders", { symbol: SYMBOL }, true)); }
  async place(intent: Intent) {
    return orderSchema.parse(await this.call("POST", "order", { symbol: SYMBOL, side: intent.side, type: "LIMIT_MAKER",
      price: intent.price, quantity: intent.quantity, newClientOrderId: intent.clientId, newOrderRespType: "RESULT" }, true));
  }
  async query(intent: Intent, orderId?: number) {
    return orderSchema.parse(await this.call("GET", "order", { symbol: SYMBOL,
      ...(orderId === undefined ? { origClientOrderId: intent.clientId } : { orderId: String(orderId) }) }, true));
  }
  async cancel(orderId: number) { await this.call("DELETE", "order", { symbol: SYMBOL, orderId: String(orderId) }, true); }
}
