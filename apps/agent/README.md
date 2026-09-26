# Letterlock memory agent (ERC-8004 agent card)

The static site behind ERC-8004 agent **#10260** on Monad mainnet, served by the Vercel project `letterlock-agent`:

- `public/.well-known/agent-card.json`: the agent's registration file (ERC-8004 `registration-v1`). Its URL,
  <https://letterlock-agent.vercel.app/.well-known/agent-card.json>, is the agent's `tokenURI` in the IdentityRegistry
  `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (registered in tx
  `0xb6b41dd5800042005b96b46d8245f0311b6461bc5cdbc90347952c3393896cf1`).
- `public/index.html`: a one-page status note at <https://letterlock-agent.vercel.app/>.

**Not live yet.** The card lists `POST /remember` as the agent's endpoint, and it says so: that endpoint goes live in
the next build phase and answers 404 today, so the card sets `"active": false`. The key published for the agent on
the Letterlock directory (`keyOfAgent(10260)`, epoch 1) is a demo key from the deploy smoke test, derived from random
bytes with no passkey; the card says not to seal real notes to it. The record is `deployments/143.json`.

Deploy (static files, no build step; `vercel.json` serves `public/` and adds CORS to `/.well-known/`):

```sh
cd apps/agent
vercel link --yes --project letterlock-agent
vercel deploy --prod --yes
curl -s -o /dev/null -w "%{http_code}\n" https://letterlock-agent.vercel.app/.well-known/agent-card.json   # 200
```

The card's URL is fixed onchain, so change its content in place; a new URL needs a `setAgentURI` transaction from the
agent's owner.
