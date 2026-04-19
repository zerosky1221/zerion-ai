# Squad Treasury

Telegram-based multi-signature trading agent built on top of the forked Zerion
CLI. Treats a group chat as the wallet's consensus layer: every swap, bridge,
or send goes through **propose → vote → execute**, and every execution is
gated by a stack of **scoped policies** that run in-process inside the CLI
*before* the transaction is signed.

**Built for the [Zerion Frontier Hackathon](https://earn.superteam.fun/listings/zerion).**

---

## Why

Most onchain agents are god-mode: one process, one key, no oversight. Squad
Treasury inverts that. The CLI holds the key, the group holds the authority,
and the custom policies guarantee that the two never decouple:

- **quorum-required** – refuses to sign unless the in-flight proposal row in
  the squad DB has the required number of yes-votes.
- **daily-spend-limit** – enforces a rolling 24-hour USD cap on the ledger.
- **token-allowlist** – rejects proposals that touch unapproved tokens or
  chains.
- **time-window** – optional "office hours" lock.

All four policies live in `cli/policies/*.mjs` and are composed via
`zerion agent create-policy --squad`. They `fail-closed` — if the squad DB
is unreachable, signing is blocked.

---

## Architecture

```
Telegram group
      │
      │ /propose swap ETH USDC 0.01 --chain base
      ▼
┌──────────────────┐        ┌─────────────────────────────┐
│  squad/bot.js    │──────▶│ squad/db.sqlite (proposals) │
└──────────────────┘        └─────────────────────────────┘
      │                                ▲
      │ quorum reached                  │  (readonly)
      ▼                                │
┌──────────────────┐                    │
│ squad/exec.js    │                    │
│  spawn(`zerion    │                   │
│    swap ...`) +   │                   │
│    ZERION_         │                  │
│    PROPOSAL_ID     │                  │
└──────────────────┘                    │
      │                                │
      │ starts CLI                      │
      ▼                                │
┌──────────────────────────────────────────────────────────┐
│ zerion CLI  ──▶  enforceExecutablePolicies(tx)           │
│                                                          │
│     1. quorum-required.mjs      (reads DB)   ────────────┤
│     2. daily-spend-limit.mjs    (reads DB)               │
│     3. token-allowlist.mjs      (reads DB)               │
│     4. time-window.mjs          (reads DB)               │
│                                                          │
│  all allow? → sign → broadcast via Zerion API           │
└──────────────────────────────────────────────────────────┘
                │
                ▼
        real onchain tx  🌐
```

DCA schedules (`/dca add`) and signal triggers (`/signal add`) feed the same
pipeline by *creating proposals*, not by executing directly. A DCA tick still
has to pass quorum — set `quorum: 1` to auto-rip, or leave it at 2+ to keep a
human in the loop.

---

## Quickstart

### 1. Clone & install

```bash
git clone https://github.com/<you>/zerion-ai.git
cd zerion-ai
npm install
npm install -g .      # optional: puts `zerion` and `squad` on PATH
```

### 2. Create the Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → grab the token.
2. Create a group chat and add the bot (turn off *Group Privacy* so it sees
   commands, or make it admin).
3. Grab the chat id (`@username_to_id_bot` or any similar util).

### 3. Scaffold squad config

```bash
squad init
```

Edit `squad.config.json`:

```json
{
  "dataDir": "./.squad-data",
  "telegram": { "token": "123:ABC...", "chatId": "-100123456789" },
  "zerion": {
    "apiKey": "zk_dev_...",
    "walletName": "squad-wallet",
    "defaultChain": "base"
  },
  "dryRun": true
}
```

Keep `dryRun: true` for the first loop — proposals will be marked executed
*without* actually hitting the chain so you can verify the bot + voting UX.

### 4. Create the Zerion wallet + agent token + policy

```bash
# interactive: produces an EVM + Solana keypair, encrypted with passphrase
zerion wallet create --name squad-wallet

# fund it (copy the shown address, send a few USDC on Base)
zerion wallet fund --wallet squad-wallet

# one policy that wires all four custom guards
zerion agent create-policy --name squad-guard --squad --chains base --expires 30d

# create the agent token bound to that policy
zerion agent create-token --name squad-bot --wallet squad-wallet --policy <policy-id>
```

Copy the printed agent token into `squad.config.json -> zerion.agentToken`
(or export `ZERION_AGENT_TOKEN`).

### 5. Run the bot

```bash
squad bot
```

In the group chat:

```
/start                                   (first caller becomes admin)
/add_member                              (reply to @alice)
/policy set quorum 2
/policy set daily_limit_usd 50
/policy set allowed_tokens ["USDC","ETH"]
/propose swap USDC ETH 5 base
```

Tap ✅ twice. The bot spawns `zerion swap ...`, every policy checks the DB,
and the CLI posts the tx hash back to the chat.

### 6. Flip `dryRun: false` for the real thing

Once you're happy with the voting flow, set `"dryRun": false` and the next
approved proposal will broadcast a real onchain transaction via the Zerion
API.

---

## Commands reference

| Command | Who | Purpose |
|---------|-----|---------|
| `/start` | anyone | bootstrap the bot; seeds first admin |
| `/add_member` (reply) | admin | add a voter |
| `/role voter\|admin` (reply) | admin | promote/demote |
| `/members` | anyone | roster |
| `/policy` / `/policy set <k> <json>` | any / admin | show / mutate scoped policies |
| `/propose swap\|bridge\|send …` | voter | create a proposal |
| `/vote <id> <yes\|no>` or tap ✅/❌ | voter | cast vote |
| `/status [id]` | anyone | active proposals |
| `/recent` | anyone | last 15 proposals |
| `/cancel <id>` | admin | reject a pending proposal |
| `/ledger` | anyone | recent executed trades + 24h spend |
| `/dca add\|list\|remove …` | voter/admin | cron-based DCA schedules |
| `/signal add\|list\|remove …` | voter/admin | price / drawdown triggers |
| `/help` | anyone | full reference |

## Policy keys (`/policy set`)

| Key | Type | Meaning |
|-----|------|---------|
| `quorum` | int | yes-votes required to approve |
| `daily_limit_usd` | number\|null | rolling 24h USD cap (null disables) |
| `allowed_chains` | string[]\|null | chain-id allowlist (null = any) |
| `allowed_tokens` | string[]\|null | symbol allowlist (null = any) |
| `time_window_utc` | `{start_hour,end_hour}`\|null | hour range (null = 24/7) |
| `proposal_expiry_minutes` | int | how long a proposal stays votable |

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | yes | bot auth |
| `TELEGRAM_CHAT_ID` | recommended | restrict bot to one chat |
| `ZERION_API_KEY` | yes | pricing + swap routing |
| `ZERION_AGENT_TOKEN` | yes | unattended trading |
| `SQUAD_DB_PATH` | no | override sqlite file |
| `SQUAD_DRY_RUN` | no | `true` to skip CLI spawn |
| `ZERION_PROPOSAL_ID` | injected | set by `exec.js`; policies read it |

## Tests

```bash
npm run test:squad
```

19 assertions covering quorum math, rejection semantics, ledger accounting
and every policy's allow/deny branches.

## Repo layout

```
cli/policies/
  quorum-required.mjs         fail-closed "only approved proposals"
  daily-spend-limit.mjs       rolling 24h USD cap
  token-allowlist.mjs         token + chain allowlist
  time-window.mjs             UTC hour window
squad/
  bin.js          `squad` CLI entrypoint
  bot.js          Telegram bot (grammy)
  db.js           sqlite schema + migrations
  members.js      roster / roles
  proposals.js    voting lifecycle
  exec.js         spawn `zerion` with ZERION_PROPOSAL_ID
  ledger.js       rolling spend window
  pricing.js      USD estimation via Zerion fungibles API
  scheduler.js    DCA cron → proposals
  signals.js      price/drawdown triggers → proposals
  config.js       env + file loader
  tests/          node:test suites
```

## Security notes

- **Passphrases never leave the CLI.** The agent token created by `zerion
  agent create-token` is the only credential the bot holds; key material lives
  in the OS-level keystore wrapper `@open-wallet-standard/core`.
- **Policies fail closed.** If `SQUAD_DB_PATH` is unreachable or the proposal
  row is missing, `quorum-required` refuses to allow the signing step.
- **Direct CLI bypass is blocked.** Running `zerion swap …` without
  `ZERION_PROPOSAL_ID` set produces "No ZERION_PROPOSAL_ID in environment" –
  nothing broadcasts.
- **The bot refuses commands from other chats** when `TELEGRAM_CHAT_ID` is
  set. Combine with a private group.
