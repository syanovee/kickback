# Kickback

Kickback shows every holder reward a wallet has received from launchpad coins, with a link to the transaction behind each payout.

Live at [getkickback.fun](https://getkickback.fun). No wallet connect, no signing: paste an address and read.

> Kickback has no token and no contract address. Any coin using the name is not affiliated.

## Why

Holding coins from StonkFun, pump.fun, Pons or Flap pays you in small, frequent drops, often in several tokens and on more than one chain. Wallet apps and explorers list these as plain incoming transfers, so it is hard to tell how much you actually earned and from which coin. Kickback finds those payouts, attributes each one to the coin and platform that paid it, prices it, and adds it up.

## Features

- Total earned from holder rewards, broken down by platform and by coin
- Every payout links to its transaction on Solscan, BscScan, Basescan, Etherscan or Blockscout
- Solana wallets are matched with their EVM wallet through bridge history and scanned together
- Share card: an image of the total and top coins, with a link preview for X
- Repeat scans of a wallet are fast because finalized history is cached at the edge

## Supported platforms

| Platform | Chain | How a payout is recognized |
|---|---|---|
| StonkFun | Solana | Transfers signed by StonkFun reward distributors |
| pump.fun | Solana | `DistributeFeeToHolders` instructions |
| Ember, Scribe | Solana | Ember distributor; Scribe memo naming the coin |
| Pons | Robinhood Chain | Distributors funded by `PonsV2FeeEscrow` |
| Flap | BNB Chain | The coin's `dividendContract()` |
| Four.meme | BNB Chain | Tax-token rewards, checked against the coin's own accounting |
| Reward-contract coins | EVM | A coin's own reward contract, only while the wallet held it |
| Creator rewards | all | Repeated airdrops from the creator of a coin the wallet held at the time |

## How counting works

1. The wallet's full history is indexed and every incoming transfer is classified as a trade, bridge, reward, plain transfer or spam.
2. A transfer counts as a reward only when the sender is a known distributor for that platform, or can be tied on-chain to a coin the wallet held at that moment.
3. Anything that looks like a reward but can't be verified is listed under "Needs review" and left out of the total.
4. Token balances are replayed from history and compared with the chain to catch missed or double-counted payouts.

Values use today's price, not the price on the day of the payout. Very active wallets (25k+ transactions) are read newest first, and the site says when that happens.

## Architecture

```
public/index.html        the app: wallet indexing, classification and UI run in the browser
functions/api/helius     Solana RPC proxy with an allow-list of read-only methods
functions/api/alchemy    EVM RPC proxy, batched
functions/api/solscan    server-side Solana history reader, returns compacted transactions
functions/api/relay      bridge history, used to link Solana and EVM wallets
functions/api/rank       wallet rank among everyone who checked
functions/api/card       share cards; functions/s and functions/c serve the link and image
```

Runs on Cloudflare Pages Functions with D1. API keys stay on the server; the API only answers requests from the site.

## Running it yourself

You need a Cloudflare account and keys for Helius, Alchemy, Relay and FomoScan.

```
npx wrangler d1 create kickback        # put the id into wrangler.toml
cp secrets.example.json secrets.json   # fill in your keys
bash deploy.sh
```

## Privacy

Each scan logs the addresses checked, the totals found, the X handle if one was typed for the share card, country, device type and referrer. IP addresses are not stored.

## Disclaimer

Kickback reads public blockchain data. It is not financial advice and it never asks for keys, signatures or funds.

Built by [@syanovee](https://x.com/syanovee).
