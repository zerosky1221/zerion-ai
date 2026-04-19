# Zerion Hosted MCP

Use Zerion's hosted MCP as the primary interface for MCP-native agent environments.

## Endpoint

```text
https://developers.zerion.io/mcp
```

## When to use

Use the **hosted MCP** when your client supports MCP and the model should choose and call tools directly (Cursor, Claude, etc.).

Use the **CLI** when your environment expects shell commands returning JSON. See [cli/README.md](../cli/README.md).

## Authentication

See the [root README](../README.md#1-choose-your-authentication-method) for full auth setup (API key or x402 pay-per-call).

## Supported clients

- Cursor: [examples/cursor](../examples/cursor/README.md)
- Claude: [examples/claude](../examples/claude/README.md)

## Wallet-analysis walkthrough

Use one of the example wallets:

- `vitalik.eth` / `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`

Then ask:

```text
Analyze this wallet and summarize:
- total portfolio value
- top holdings
- DeFi positions
- recent transactions
- PnL
```

The tool catalog in [`mcp/tools/`](./tools/) documents the concrete wallet capabilities.

## Failure modes

- Missing or invalid API key
- Invalid address or ENS resolution failure
- Unsupported chain filters
- Rate limits (429)
- Upstream timeout or temporary unavailability
- Empty or partially bootstrapped wallet state
