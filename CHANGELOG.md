# @iqai/mcp-kalshi

## 0.1.3

### Patch Changes

- Add disarmed a1 reads and strategy accounting beside the 0.1.2 order contract.
  Structured balance, position, order, fill, and settlement reads report cursors
  and UNKNOWN for missing fixed-point fields. Optional dollar prices require a
  fresh price grid. Optional clientOrderId is caller-stable. The $5 ledger
  stays disarmed, does not submit orders, and does not constrain other account
  callers or the SENATEAK holding.

## 0.1.2

### Patch Changes

- Pin kalshi-typescript to 3.35.0 and map order writes to the V2 event-order API.
  CREATE_ORDER translates YES/NO buy/sell cents onto the YES book, sends fixed-point
  counts and dollar prices, and does not retry. Cancel and decrease require a market
  ticker and use the V2 acknowledgement shape. Amend and batch create stay fail-closed.
  Read tools follow the SDK 3.35 fixed-point fields and the shifted getMarkets and
  getPositions argument lists. This fork is not published to npm.

## 0.1.1

### Patch Changes

- eed3c34: Fix lazy client initialization and upgrade fastmcp to 3.30.1
  - Use getter for KalshiClient to defer initialization until first API call
  - This allows the MCP server to start without requiring KALSHI_API_KEY
  - Upgrade fastmcp from 1.27.7 to 3.30.1 to fix completions compatibility

## 0.1.0

### Minor Changes

- 1bd6e8e: feat: initial release of Kalshi MCP server

  MCP server for interacting with Kalshi prediction markets including:

  - Market discovery and search
  - Market details and series information
  - Read-only access for market research
