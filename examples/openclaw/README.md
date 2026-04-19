# OpenClaw example

This example shows how to use `zerion` as a command-based tool in an OpenClaw-like environment.

## Install

```bash
npm install -g zerion
```

## Environment

```bash
export ZERION_API_KEY="zk_dev_..."
```

## Tool contract

OpenClaw-style runtimes work best when the tool:

- is a single command
- returns JSON on stdout
- exits non-zero on failure

`zerion` is built for that shape.

## Minimal invocation

```bash
zerion wallet analyze 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

## Suggested tool registration

See `tool.json` for a minimal command-tool registration shape.
