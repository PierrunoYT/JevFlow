# Kraken setup and recovery guide

JevFlow supports **Kraken Spot BTC/CHF only**. Kraken calls Bitcoin `XBT` in parts
of its REST API; the bot maps this to BTC. There is no wallet inside the bot:
your CHF and Bitcoin stay in your Kraken account.

**This integration is experimental, not a proven profitable strategy.** Public
market access and mocked execution tests do not verify authenticated trading.
This code uses the production Spot API, not a virtual-money sandbox. Dry-run and
`validate=true` do not simulate fills or demonstrate safe live operation.

## 1. Install and check without credentials

Install Bun 1.3.10, clone this repository, and run from its root:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run demo
bun run kraken check
```

`check` reads public BTC/CHF rules (filtered for country code `CH`) and the order
book. It never authenticates or places orders. Successful output is not a claim
that your account is eligible or that the bot is ready for real money.

## 2. Create and secure your account

Use the official [Kraken website](https://www.kraken.com/). Complete identity
verification with your Swiss residence and confirm BTC/CHF spot trading and CHF
funding are available to **your account**. Enable sign-in two-factor authentication.
Do not bypass geographic restrictions. Use a dedicated small spot account where
permitted; do not share it with another bot or manual orders. No margin, credit,
futures, staking, or Earn allocation is managed by JevFlow.

Create a dedicated [API key](https://support.kraken.com/articles/360000919966-how-to-create-an-api-key).
Required permissions:

- Query Funds.
- Query Open Orders & Trades.
- Query Closed Orders & Trades.
- Create & Modify Orders for validation/live submission only.
- Cancel & Close Orders for live cancellation/reconciliation only.

**Do not grant Withdraw Funds, Deposit Funds, or Earn permissions.** The bot has
no funding or withdrawal API methods. Its software limits do not restrict what
a stolen trading key could do. Restrict the key to your host's stable IP where
practical. API-key OTP authentication is not implemented; this is separate from
the sign-in 2FA you should keep enabled. A read-only key is sufficient for initial
status/dry-run checks. If you later replace the key, preserve state and follow the
key-binding warning below rather than deleting the database.

```bash
cp -n .env.example .env
chmod 600 .env
```

Edit `.env` locally (Bun loads it), or use your host's secret manager:

```dotenv
KRAKEN_API_KEY=your_public_api_key
KRAKEN_API_SECRET=your_base64_private_api_secret
TYPESAFE_API_KEY=your_typesafe_key
KRAKEN_ENABLE_LIVE=
```

Keep live enablement empty. Never put credentials in chat, Git, screenshots,
shell arguments, or market data. `.env` and `data/` are ignored by Git.

## 3. Check balances and observe

```bash
bun run kraken status
bun run kraken run
```

`status` reads balances and all open orders, plus local pending/halt state. It
does not prove order permission. `run` is an always-hold observer by default:
no Jev billing or exchange writes. Both use private API reads and persist a
nonce locally. Stop with Ctrl+C; this writes `data/kraken.STOP`.

With `TYPESAFE_API_KEY` set, `bun run kraken run --jev` opts into **billable** model
calls and dry-run order proposals. It still cannot place or cancel orders.
Follow the recovery steps to remove a prior stop before restarting.

## 4. Funding is a manual exchange action

If you independently decide to fund the account, open Kraken's funding/deposit
screen, choose **CHF**, and follow the instructions shown for your own account.
Use a bank account in the same legal name. Kraken describes CHF bank funding
through [Bank Frick](https://support.kraken.com/articles/360032773251-bank-frick-funding-provider).
Check the current minimum, fee, reference, and bank details in Kraken; do not use
bank details from a guide or chat. Fees can be significant for small deposits.

CHF 50 is a **software allocation ceiling, not a recommended deposit**. Use only
an amount you can afford to lose and leave room for price changes. The bot halts
if total BTC-at-bid plus CHF exceeds CHF 50, even due to appreciation. Existing
holdings count. You do not need to buy Bitcoin manually for buy orders; a sell
requires available BTC. Trading minimums may make small orders impossible.

## 5. Validate without placing an order

```bash
bun run kraken validate
```

This builds a buy of at most CHF 10 from current rules and available balances,
then calls Kraken AddOrder with **`validate=true`**. It does not submit to the
matching engine. It needs order-creation permission and sufficient free CHF for
the local sizing check. If minimums, spread, funds, or permissions prevent
validation, investigate; do not automatically raise limits. Successful validation
does not verify fills, cancellation, recovery, or profitability.

## 6. Live execution requires a deliberate opt-in

Before using this command, review held-out strategy results with fees/slippage,
the code and risk limits, and the remaining lack of credentialed execution tests.
Have the Kraken interface open for manual intervention. Do not run unattended.

The following command can **spend real money**. It is shown for a human operator
to run only after accepting that risk; setup does not run it automatically:

```bash
KRAKEN_ENABLE_LIVE=I_ACCEPT_REAL_MONEY_RISK \
  bun run kraken run --jev --execute-live --acknowledge-live
```

All three flags and the exact environment opt-in are required. The offline
baseline cannot trade. No forced trade is provided: model and deterministic
gates can keep the bot at hold indefinitely.

### Limits and execution behavior

- BTC/CHF spot only; no borrowing or shorting. Credit accounts are rejected.
- CHF 10 maximum order notional, 1% buy fee reserve, CHF 50 proposed BTC exposure,
  CHF 50 account-pair allocation ceiling, ten submission attempts per UTC day.
- CHF 5 drawdown from persisted peak BTC/CHF equity latches a halt. This includes
  other BTC/CHF holdings, deposits, and withdrawals, not just bot P&L. It is not a
  guaranteed loss limit and does not liquidate remaining BTC.
- Exact eight-decimal arithmetic, tick/lot flooring, minimum volume and cost
  checks. A minimum above the order cap means no trade, not an increased order.
- Post-only limit orders with quote-currency fee preference, GTD and `expiretm=+15`.
  Server expiry is requested as well as local cancellation; actual terminal
  status must still be confirmed. Fees and adverse selection can cause losses.
- Ten-second waits between cycles to leave private API rate-limit headroom;
  60-second/five-observation warmup; resets after observation gaps over 25 seconds.
  Account/book/prediction latency must fit one
  second. Depth level timestamps are not used as a market-age guarantee.
- The runner polls REST book data, not the recorder's trade stream: VWAP is null,
  trade flow unavailable. Probability ≥ 0.65 and confidence ≥ 0.55 are unvalidated.
  It does not ask for a fresh model decision while an order rests.
- One durable intent before any submission. No automatic submission retries.
  Foreign open orders in **any market** block new orders and are never canceled.
- Five-second HTTP timeout, redirects forbidden, sanitized errors, in-process
  rate-limit cooldown. Restarting does not clear exchange rate limits.

## Stop and recover

```bash
bun run kraken stop
```

This writes a local stop file with no credentials/network required. The live loop
attempts cancellation when it observes it; SIGINT/SIGTERM also request cleanup.
**Process exit is not cancellation confirmation.** Inspect Kraken directly if
the process, network, or exchange is unavailable. Check remaining BTC exposure.

Once the original process has exited:

```bash
bun run kraken status
bun run kraken reconcile --acknowledge-live
```

Reconcile can cancel the tracked **real** order and requires acknowledgement even
without the live-submission environment setting. It then queries terminal state.
On lost submission acknowledgements, the bot searches open orders and up to 1,000
recent closed orders by the persisted UUID. No match means **unknown**, not rejected.
Explicit submission errors are also retained conservatively. Do not delete an
unresolved intent or repeatedly submit. There is no CLI “forget order” override;
leave the bot stopped and investigate exchange history with developer assistance.

After confirming no open or unresolved orders, reviewing the halt cause, and
deciding to restart, manually remove `data/kraken.STOP` and run:

```bash
bun run kraken reset-risk --acknowledge-risk-reset
```

Reset refuses unresolved/open orders or a stop file. It clears the halt and
high-water mark, not the audit, daily attempt counts, or nonce. It is not an
automatic response to losses. A still-oversized account will halt again.

### Keep state and credentials private

`data/kraken.sqlite` stores pending intent, API-key/exchange binding, risk state,
audit records, and a monotonic nonce with FULL synchronous writes. Back it up
with the process stopped. Balances and order history are private financial data;
audit retention is manual. Do not commit or share the database.

All private CLI commands acquire `data/kraken.lock`, including status/validation.
Use Kraken's interface to inspect orders while the bot holds that lock. Remove
a stale lock only after proving the old process is gone. One account/key must
have one process and one stable working directory; this is not a distributed lock.
Nonce state survives clock rollback/restarts but not deletion or stale backup
restoration. API-key rotation changes the binding and needs reviewed state
recovery; deleting the database is not a safe migration.

### Migration and hosting

Binance support and `bun run testnet` have been removed. Stop any old process and
resolve its orders through the old exchange **before upgrading**. Keep old
`data/testnet.*` files as evidence; they are not imported or deleted by Kraken.
Remove obsolete Binance secrets from your host yourself. Old normalized JSONL
can still be replayed offline; do not mix markets or connection segments.

In Amp orbs, run long-lived observers with a supervised service:

```bash
amp orb service start jevflow-kraken --command 'bun run kraken run'
amp orb service logs jevflow-kraken
bun run kraken stop
amp orb service stop jevflow-kraken
```

Do not put keys in the service command or enable unattended live execution.
There is no web UI or portal requirement.

## API references

- [Authentication and published signature vector](https://docs.kraken.com/api/docs/guides/spot-rest-auth)
- [Asset pair rules](https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs)
- [Extended balances](https://docs.kraken.com/api-reference/account-data/get-extended-balance)
- [AddOrder and validate](https://docs.kraken.com/api-reference/trading/add-order)
- [Order queries](https://docs.kraken.com/api-reference/account-data/query-orders-info)
