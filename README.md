# @marketmayhem/mcp

Market Mayhem for AI agents: launch and trade BSC tokens through an MCP server.

- **Your wallet signs, locally.** The key never leaves this process. Market Mayhem's API builds and simulates each transaction; this server checks it against your limits and signs it.
- **Dry run by default.** Until you set `MM_LIVE=1`, every tool says exactly what it would do and signs nothing.

## Tools

| Tool | What it does |
|---|---|
| `get_settings` | The network, contracts, fees and pair currencies. Read first. |
| `new_launches` | Tokens launched, newest first. Pass `after` to get only new ones. |
| `get_token` | One token: pool, fee tier, pair currency, creator. |
| `quote` | What a buy or sell would get now, with price impact and fee. |
| `buy` / `sell` | Trade, within your caps and allowlist. `sell` takes `amount` or `percent`. |
| `launch_token` | Launch a token, with an optional first buy split across up to 8 wallets (the dead address burns), and `burnPct` for the royalty. |
| `tx_status` | Pending, mined or indexed. |
| `my_referral_earnings` / `referral_link` | Earn a share of the fee on every trade your link brings, for life. |

Errors come back as `{ error, message, fix }`, so the agent can correct itself.

## Setup

Claude Desktop (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "marketmayhem": {
      "command": "npx",
      "args": ["-y", "@marketmayhem/mcp"],
      "env": {
        "MM_PRIVATE_KEY": "0x… the agent's own wallet",
        "MM_MAX_PER_TX": "BNB:0.05",
        "MM_MAX_PER_DAY": "BNB:0.25"
      }
    }
  }
}
```

Claude Code: `claude mcp add marketmayhem -e MM_PRIVATE_KEY=0x… -- npx -y @marketmayhem/mcp`

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MM_LIVE` | unset (dry run) | `1` lets the agent send. |
| `MM_PRIVATE_KEY` | — | The agent's own wallet. Use a wallet made for it, holding only what it may spend. |
| `MM_WALLET` | — | Without a key: an address to dry run as. It can never send. |
| `MM_MAX_PER_TX` | `BNB:0.05` | The most one transaction may spend, per currency (`BNB:0.05,USDT:50`). |
| `MM_MAX_PER_DAY` | `BNB:0.25` | The most per UTC day, per currency. A currency with no cap cannot be spent. |
| `MM_ALLOW_TOKENS` | any | Comma-separated tokens the agent may buy or sell. |
| `MM_API_KEY` | — | Your API key: higher limits, and your wallet becomes the default referrer on every trade. |
| `MM_API_URL` | `https://marketmayhem.co/api/v1` | The API. |
| `MM_RPC_URL` | a public BSC node | The node transactions are sent through. |
| `MM_STATE_DIR` | `~/.marketmayhem-mcp` | Where today's spend is kept, so a restart can't reset the daily cap. |

A sell spends no money, so only the allowlist applies to it. A first-time sale sends the one-time approvals first, then the trade.
