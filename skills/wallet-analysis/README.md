# wallet-analysis

`wallet-analysis` is the flagship skill in this repo.

It is intentionally narrow:

- resolve or confirm the wallet query
- inspect portfolio overview
- inspect holdings and DeFi positions
- inspect recent transactions
- inspect PnL
- summarize the wallet clearly for the end user

Use this skill when you want a fast, read-only wallet briefing for a human or an agent.

## Backends

This skill is designed to work with either:

- Zerion's hosted MCP in MCP-native clients
- `zerion` in OpenClaw-like command-based frameworks

## Example wallets

- `vitalik.eth`
- `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
- ENS DAO treasury / `0xFe89Cc7Abb2C4183683Ab71653c4cCd1b9cC194e`
- Aave collector / `0x25F2226B597E8F9514B3F68F00F494CF4F286491`
