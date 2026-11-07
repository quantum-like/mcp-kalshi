# 📈 Kalshi MCP Server

[![npm version](https://img.shields.io/npm/v/@iqai/mcp-kalshi.svg)](https://www.npmjs.com/package/@iqai/mcp-kalshi)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## 📖 Overview

The Kalshi MCP Server enables AI agents to interact with [Kalshi](https://kalshi.com), a regulated prediction market exchange in the US. This server provides comprehensive access to market data, real-time pricing, order books, portfolio management, and trading capabilities.

By implementing the Model Context Protocol (MCP), this server allows Large Language Models (LLMs) to discover prediction markets, analyze odds (probabilities), execute trades, and track portfolio performance directly through their context window, bridging the gap between AI and regulated prediction markets.

## ✨ Features

*   **Market Discovery**: Search and filter prediction markets by status, series, or event keywords.
*   **Real-time Pricing**: Access live price data, implied probabilities, and depth-of-market (order books) for any market.
*   **Portfolio Tracking**: Monitor account balance, positions, trade history, fills, and settlements.
*   **Trading Operations**: Place one limit order at a time. YES/NO prices in whole cents are mapped onto the YES book. Cancel and decrease require the market ticker. Market orders are rejected. Amend and batch-create stay fail-closed.

## 📦 Installation

### 🚀 Using npx (Recommended)

To use this server without installing it globally:

```bash
npx @iqai/mcp-kalshi
```

### 🔧 Build from Source

```bash
git clone https://github.com/quantum-like/mcp-kalshi.git
cd mcp-kalshi
pnpm install
pnpm run build
```

## ⚡ Running with an MCP Client

Add the following configuration to your MCP client settings (e.g., `claude_desktop_config.json`).

### 📋 Minimal Configuration

```json
{
  "mcpServers": {
    "kalshi": {
      "command": "npx",
      "args": ["-y", "@iqai/mcp-kalshi"],
      "env": {
        "KALSHI_API_KEY": "your_api_key_here",
        "KALSHI_PRIVATE_KEY_PATH": "./path/to/your/private-key.pem"
      }
    }
  }
}
```

### ⚙️ Advanced Configuration (Local Build)

```json
{
  "mcpServers": {
    "kalshi": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-kalshi/dist/index.js"],
      "env": {
        "KALSHI_API_KEY": "your_api_key_here",
        "KALSHI_PRIVATE_KEY_PATH": "/absolute/path/to/private-key.pem"
      }
    }
  }
}
```

## 🔐 Configuration (Environment Variables)

| Variable | Required | Description | Default |
| :--- | :--- | :--- | :--- |
| `KALSHI_API_KEY` | Yes | Your Kalshi API key ID | - |
| `KALSHI_PRIVATE_KEY_PATH` | Yes* | Path to your RSA private key PEM file | - |
| `KALSHI_PRIVATE_KEY_PEM` | Yes* | RSA private key as PEM string (alternative to path) | - |

*Either `KALSHI_PRIVATE_KEY_PATH` or `KALSHI_PRIVATE_KEY_PEM` is required.

### 🔑 Getting API Credentials

1. Log in to your Kalshi account
2. Go to Settings > API Keys
3. Create a new API key pair
4. Download and save your private key securely
5. Note your API Key ID

## 💡 Usage Examples

### 🔍 Market Discovery
*   "What prediction markets are currently open on Kalshi?"
*   "Show me markets related to cryptocurrency"
*   "Find markets about the S&P 500"

### 📊 Analytics & Pricing
*   "Get the order book for INXD-25JAN20"
*   "What is the current implied probability for this market?"
*   "Show me recent trades on this market"

### 💼 Portfolio Management
*   "What's my current account balance?"
*   "Show me my open positions"
*   "What trades have I made today?"
*   "List my recent settlements"

### 📝 Trading
*   "Place a limit buy order for 10 Yes contracts at 45 cents on [market]"
*   "Cancel order [order_id] on market [ticker]"
*   "Show me all my resting orders"

## 🛠️ MCP Tools

<!-- AUTO-GENERATED TOOLS START -->

### `BATCH_CANCEL_ORDERS`
Cancel multiple orders at once (up to 20 orders per batch).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | array | ✅ | Array of order IDs to cancel (max 20) |

### `GET_BALANCE`
Get the current account balance and portfolio value. Values are returned in dollars.

_No parameters_

### `GET_MARKET_ORDERBOOK`
Get the current orderbook for a market showing bid prices and quantities for both Yes and No sides.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | ✅ | The market ticker |
| `depth` | number |  | Depth of orderbook to retrieve (1-100, default 10) |

<!-- AUTO-GENERATED TOOLS END -->

## 👨‍💻 Development

### 🏗️ Build Project
```bash
pnpm run build
```

### 👁️ Development Mode (Watch)
```bash
pnpm run watch
```

### ✅ Linting, tests, and build
```bash
pnpm run lint
pnpm test
pnpm run build
```

`pnpm test` uses a mocked Axios transport. It does not call Kalshi and it does not prove the exchange accepted an order.

## Profiles

`KALSHI_MCP_PROFILE` defaults to `a1`. That process registers read tools only. Create, cancel, decrease, and batch-cancel are absent from the tool list, and calling those service methods throws before an SDK client exists. The a1 strategy submit function, which is not registered as a tool, checks a fresh price grid and then the persistent ledger before it can call a transport. A disarmed ledger, the default, never reaches that call.

`KALSHI_MCP_PROFILE=a2` is the explicit compatibility profile for the deployed connector. It keeps the 0.1.2 whole-cent create path, including orders that do not carry `price_ranges`. Do not point the running a2 process at this bundle unless that profile is selected on purpose. The default a1 profile will not place those orders.

The offline bundle ships compiled tests. From the extracted directory, with no install and no network:

```bash
node offline-accept.mjs
```

That command requests the TAP reporter and also accepts the Node spec summary (`ℹ tests N`). It exits nonzero if it discovers zero tests, a count other than `EXPECTED_TESTS`, or any failing test. It does not call Kalshi.

## A1 readiness (disarmed)

Version 0.1.4 keeps the 0.1.2 acknowledgement text for a2-profile cent orders.

- `READ_BALANCE`, `READ_POSITIONS`, `READ_ORDERS`, `READ_FILLS`, and `READ_SETTLEMENTS` report fixed-point strings, full ids, cursors, and completeness. A missing number is `UNKNOWN`. A failed page is not an empty account.
- `CREATE_ORDER` accepts an optional `clientOrderId`. Omitting it still generates one id for that call and does not retry. Optional dollar prices require `priceRanges` observed at `priceObservedAt`. Legacy cent fields stay whole cents and are not reinterpreted as dollars.
- `A1_STRATEGY_STATUS` reports a disarmed $5 ledger. The server does not arm it and does not route `CREATE_ORDER` through it. The ledger cannot stop another API key, the a2 connector, or a manual order from spending the same Kalshi account. `SENATEAK` is refused inside the strategy API only.
- Sealed-date screening defaults to mode `000` and an empty historical day list. It is not a collector and it does not read market-data files.

Remaining gates before any reconnect: confirm the installed binary hash, compare live positions and pages read-only, keep writes disabled on mismatch, and do not clear an external monitor-only hold. Flat fee series and incomplete account reads halt the strategy. The legacy cent path is not checked against the market tick grid.

## Deploying this fork

This package is the `quantum-like/mcp-kalshi` fork. It is not published to npm. The parent host installs the self-contained offline bundle, which already contains `dist/` and the production `node_modules` resolved from `pnpm-lock.yaml`.

Extract that bundle and point the existing stdio MCP configuration at its server:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/iqai-mcp-kalshi-0.1.2/dist/index.js"],
  "env": {
    "KALSHI_API_KEY": "your_api_key_here",
    "KALSHI_PRIVATE_KEY_PATH": "/absolute/path/to/private-key.pem"
  }
}
```

`KALSHI_PRIVATE_KEY_PEM` can be used instead of `KALSHI_PRIVATE_KEY_PATH`. The base URL stays `https://api.elections.kalshi.com/trade-api/v2`. Swapping this command is an operator step. This repository does not restart a running connector, place an order, or change any schedule.

Pinned production versions inside the bundle: `dedent@1.6.0`, `fastmcp@3.30.1`, `kalshi-typescript@3.35.0`, `zod@3.25.7`, `axios@1.21.0`.

Rollback: point the same MCP configuration back at the previous server binary. Leave any external monitor-only hold in place until that hold is cleared by its own procedure. The pre-repair source revision is `15c12b37ed9f1b0e3fc0000e4918e9191c2b282b`.

### 📁 Project Structure
*   `src/tools/`: Individual tool definitions
*   `src/services/`: API client and business logic
*   `src/lib/`: Shared utilities (config, http)
*   `src/index.ts`: Server entry point

## 🔒 Security & Privacy

Your RSA private key is used to sign API requests. Here's what you need to know:

**Your Key Stays Safe:**
- The MCP server runs entirely on your local machine
- Your private key never leaves your computer
- No data is sent to any third-party servers except Kalshi's official API

**Important Security Practices:**
- Never commit your private key to version control
- Never share your configuration file containing the key path
- Only use this on trusted, secure machines

## 📚 Resources

*   [Kalshi API Documentation](https://docs.kalshi.com)
*   [Kalshi TypeScript SDK](https://docs.kalshi.com/sdks/typescript/quickstart)
*   [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
*   [Kalshi Platform](https://kalshi.com)

## ⚠️ Disclaimer

This project is an unofficial tool and is not directly affiliated with Kalshi. It interacts with financial and prediction market data. Users should exercise caution and verify all data independently. Trading in prediction markets involves risk.

## 📄 License

[MIT](LICENSE)
