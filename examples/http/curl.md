# curl examples

Set your API key:

```bash
export ZERION_API_KEY="zk_dev_..."
export ZERION_BASIC_AUTH="$(printf '%s:' \"$ZERION_API_KEY\" | base64)"
```

## Portfolio

```bash
curl -H "Authorization: Basic $ZERION_BASIC_AUTH" \
  "https://api.zerion.io/v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/portfolio"
```

## Positions (all)

```bash
curl -H "Authorization: Basic $ZERION_BASIC_AUTH" --globoff \
  "https://api.zerion.io/v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/positions/?filter[positions]=no_filter&filter[chain_ids]=ethereum"
```

## Positions (simple tokens only)

```bash
curl -H "Authorization: Basic $ZERION_BASIC_AUTH" --globoff \
  "https://api.zerion.io/v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/positions/?filter[positions]=only_simple"
```

## Positions (DeFi only)

```bash
curl -H "Authorization: Basic $ZERION_BASIC_AUTH" --globoff \
  "https://api.zerion.io/v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/positions/?filter[positions]=only_complex"
```

## Transactions

```bash
curl -H "Authorization: Basic $ZERION_BASIC_AUTH" --globoff \
  "https://api.zerion.io/v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/transactions/?page[size]=10"
```

## PnL

```bash
curl -H "Authorization: Basic $ZERION_BASIC_AUTH" \
  "https://api.zerion.io/v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/pnl"
```

## Chains

```bash
curl -H "Authorization: Basic $ZERION_BASIC_AUTH" \
  "https://api.zerion.io/v1/chains/"
```
