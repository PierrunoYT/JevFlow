import type { Action, Book, Trade } from "./types";

export const limits = {
  initialCash: 10_000,
  orderNotional: 100,
  maxExposure: 500,
  maxDrawdown: 25,
  maxSpreadBps: 10,
  orderAgeMs: 15_000,
  feeRate: 0.001,
};

export interface Order {
  id: number;
  side: "buy" | "sell";
  price: number;
  remaining: number;
  timestampMs: number;
  activeAtMs: number;
}

export class PaperBroker {
  cash = limits.initialCash;
  position = 0;
  fees = 0;
  fills = 0;
  highWatermark = limits.initialCash;
  maxDrawdown = 0;
  halted = false;
  order: Order | null = null;
  private nextId = 1;

  equity(mid: number) { return this.cash + this.position * mid; }

  mark(mid: number) {
    const equity = this.equity(mid);
    this.highWatermark = Math.max(this.highWatermark, equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.highWatermark - equity);
    if (this.maxDrawdown >= limits.maxDrawdown) {
      this.halted = true;
      this.order = null;
    }
  }

  expire(timestampMs: number) {
    if (this.order && timestampMs - this.order.timestampMs >= limits.orderAgeMs) {
      const expired = this.order;
      this.order = null;
      return expired;
    }
    return null;
  }

  place(action: Action, book: Book, latencyMs = 0): string {
    if (this.halted) return "risk halt latched";
    if (action === "hold") return "strategy hold";
    if (this.order) return "previous order still open";
    const mid = (book.bid + book.ask) / 2;
    if ((book.ask - book.bid) / mid * 10_000 > limits.maxSpreadBps) return "spread too wide";
    const price = action === "buy" ? book.bid : book.ask;
    const size = limits.orderNotional / price;
    if (action === "buy") {
      if (this.cash < limits.orderNotional * (1 + limits.feeRate)) return "insufficient cash";
      if ((this.position + size) * mid > limits.maxExposure) return "exposure limit";
    } else if (this.position < size) return "insufficient inventory";
    this.order = { id: this.nextId++, side: action, price, remaining: size,
      timestampMs: book.timestampMs, activeAtMs: book.timestampMs + Math.ceil(latencyMs) };
    return "order placed";
  }

  trade(trade: Trade) {
    this.expire(trade.timestampMs);
    const order = this.order;
    if (!order || trade.timestampMs <= order.activeAtMs) return null;
    // Strict trade-through, not touch: no assumption about queue priority at the limit.
    const crosses = order.side === "buy"
      ? trade.side === "sell" && trade.price < order.price
      : trade.side === "buy" && trade.price > order.price;
    if (!crosses) return null;
    const size = Math.min(order.remaining, trade.size);
    const notional = size * order.price;
    const fee = notional * limits.feeRate;
    this.cash += (order.side === "buy" ? -notional : notional) - fee;
    this.position += order.side === "buy" ? size : -size;
    this.fees += fee;
    this.fills++;
    order.remaining -= size;
    if (order.remaining < 1e-12) this.order = null;
    return { orderId: order.id, timestampMs: trade.timestampMs, side: order.side, price: order.price, size, fee };
  }
}
