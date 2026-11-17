# Contributing

Kickback is a free tool that shows a wallet every holder reward it received, each with its transaction. Contributions that make that answer more correct, more complete or faster are welcome.

## In scope

- **Correctness.** A payout that is missed, counted twice, given to the wrong coin or platform, or priced wrong. Include the wallet, the transaction and what the right answer is.
- **New reward platforms.** A launchpad or protocol that pays holders and isn't recognized yet. Include a few real payout transactions and how they can be told apart from ordinary transfers.
- **Speed.** Scans of wallets with 10k+ transactions. Show the before and after time on the same wallet.
- **Security.** Ways to abuse the api, burn provider credits, forge share cards or results, or make the site load something it shouldn't.
- **Tests** for payout detection, built from real transactions.

## Out of scope

- Visual or copy changes, unless they fix a broken flow.
- New dependencies or build steps. The site is plain HTML and JS on Cloudflare Pages and Functions.
- Anything that needs a wallet connection, a signature or a private key. Kickback only ever reads public addresses.

## How

1. Open an issue first for anything bigger than a small fix.
2. One change per pull request, with the wallet and transactions you tested on.
3. Never commit keys. Secrets live in Cloudflare and GitHub secrets only (see `secrets.example.json` for the names).

Run it locally with `npx wrangler pages dev public` and your own free provider keys in `.dev.vars`.
