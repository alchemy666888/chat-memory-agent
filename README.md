# chat-memory-agent

Writer and explicit summarization service for one cumulative summary per Telegram chat. It stores raw user and assistant messages and, only when an external caller asks, summarizes one pending chat with DeepSeek.

There is no user interface, scheduler, Telegram webhook, or automatic processing.

## Requirements

- Node.js 22 or newer
- pnpm 10.28.1 (`packageManager` in `package.json`)
- PostgreSQL for `chat_memory`
- A DeepSeek API key for real summarization

## Setup

```bash
pnpm install --frozen-lockfile
```

Copy `.env.example`. Create the runtime and MCP database roles, then initialize the schema with the migrator URL:

```bash
pnpm db:init
```

Ingestion and processing use different bearer tokens. See `docs/chat-memory-contract-v1.md` for the wire contract and `docs/operations.md` for leases, commit uncertainty, and rollback.

## Endpoints

- `POST /api/v1/messages` stores one raw message with the ingest token. It does not call DeepSeek.
- `POST /api/v1/memory/process` accepts `{}` with the process token, chooses one eligible chat, and summarizes one captured batch.
- `GET /api/health` reports readiness without secrets or row contents.

Trigger processing with an environment-supplied token. The caller timeout must be longer than the 240-second application budget:

```bash
curl -sS -X POST "$CHAT_MEMORY_PROCESS_URL" \
  -H "authorization: Bearer $CHAT_MEMORY_PROCESS_TOKEN" \
  -H "content-type: application/json" \
  --data '{}'
```

On Vercel, the processing route allows a 300-second function duration. The application still stops at its own deadline.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm test:contracts
pnpm test:integration
pnpm build
```

Integration tests need a local PostgreSQL database. They are not a live model-quality evaluation. Set `CHAT_MEMORY_LIVE_DEEPSEEK=1` and `DEEPSEEK_API_KEY` to run `pnpm test:live` separately.

## Limits

A successful ingestion response means the row committed. The bot does not wait for that response, and a failed background save is not retried here. Processed raw rows are kept. A lost commit acknowledgement is reported as `COMMIT_OUTCOME_UNKNOWN` and is not replayed automatically.
