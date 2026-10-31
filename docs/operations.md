# Operations

Initialize the database first, deploy the read-only MCP service second, and integrate agent-bot third. Use separate test or Preview and Production databases. Do not point those stages at the same credentials.

## Initialize

Create two login roles before initialization. Do not give either role DDL rights.

- `CHAT_MEMORY_RUNTIME_ROLE` needs `USAGE` on schema `chat_memory`, `SELECT`, `INSERT`, and `UPDATE` on both tables, and `USAGE`/`SELECT` on the identity sequence.
- `CHAT_MEMORY_MCP_ROLE` needs `USAGE` on the schema and `SELECT` on both tables.

Set `DATABASE_MIGRATOR_URL` to a privileged URL used only by the initializer. Set `AIVEN_PG_CA` when the provider requires a custom CA. Loose `sslmode` values `prefer`, `require`, and `verify-ca` are rewritten to `verify-full` unless `uselibpqcompat=true` is already present. When a CA is configured, URL SSL parameters are removed and TLS verification stays on.

```bash
pnpm db:init
```

The command applies `migrations/0001_chat_memory.sql`, grants the two roles, and compares the catalog with `migrations/0001_chat_memory.manifest.json`. Running it again is safe when the catalog matches. A conflicting table, constraint, or index fails the command and is not altered. The initializer does not run on cold start, during `next build`, or inside an API handler. There is no down migration. Rolling back a deployment keeps the schema and the rows.

## Runtime

`DATABASE_URL` is the runtime role. Each warm instance opens at most 3 PostgreSQL connections. The aggregate budget is `warm_instances * 3` for this service, plus the MCP service's own pools and one short-lived migrator connection during initialization. Size `max_connections`, or a session pooler in front of PostgreSQL, above that total. This service uses ordinary parameterized queries.

Required runtime settings:

- `CHAT_MEMORY_INGEST_TOKEN` and `CHAT_MEMORY_PROCESS_TOKEN`, distinct from each other and from the read token if that variable is also present.
- `DEEPSEEK_API_KEY` for processing. `DEEPSEEK_BASE_URL` defaults to `https://api.deepseek.com` and must be HTTPS. `DEEPSEEK_SUMMARY_MODEL` defaults to `deepseek-v4-pro`.
- `MEMORY_PROCESS_TIMEOUT_MS` defaults to 240000 and cannot be configured higher. The processing route sets `maxDuration` 300 so the platform outlives the application deadline. No request continues after the function returns.
- `MEMORY_BATCH_MAX_MESSAGES` and `MEMORY_BATCH_MAX_CHARACTERS` default to 100 and 64000 and cannot be configured higher.

Ingestion and processing tokens are different bearer credentials. A missing or invalid credential returns before any SQL or DeepSeek call. Health is unauthenticated and returns only `{"status":"ok"}` or `{"status":"unavailable"}`.

## Processing and recovery

Processing starts only when an operator or external caller posts an empty JSON object to `/api/v1/memory/process`. The service selects the chat whose oldest pending `received_at` is earliest, with numeric chat ID as the tie-break, locks that parent with `FOR UPDATE SKIP LOCKED`, and captures one oldest prefix. It does not loop across chats or batches.

The per-chat lease is 330 seconds of database time plus a random UUID fencing token. The model runs only after that claim transaction commits. Finalization locks the parent again and commits the summary, version increment, and captured row completion together. Rows that arrive during the model call stay pending, including rows whose identity values were allocated before a later commit.

On model, validation, deadline, or fence failure, the previous summary and pending statuses stay in place. The service clears the lease only when the fencing token still matches. A hard crash leaves the lease until it expires; the next explicit call can reclaim it. There is no cleanup scheduler.

If the connection drops while `COMMIT` is in flight, the response is `COMMIT_OUTCOME_UNKNOWN` with `retryable: false`. The service does not claim the transaction rolled back and does not start another model call. A later explicit trigger reads the committed state. Consumed rows are no longer pending, so they are not summarized twice. A lost HTTP response has the same ambiguity: look at the stored version and statuses, or issue a new explicit call, instead of replaying the old batch.

An oversized raw row is summarized through in-memory chunks of at most 32,000 code points, with at most 16 provider exchanges and one compression exchange. If that budget or the 240-second deadline cannot cover the row, it stays pending. The log records the request ID, chat ID, captured row count, character count, and failure code. It does not record message text, summary text, bearer tokens, database URLs, CA material, or model reasoning.

Logs also include phase durations, summary version, lease outcome, model name, and a provider request ID when the provider supplies a short safe identifier.

## Release and rollback

Deploy this service and initialize the empty schema before the MCP reader. Configure agent-bot only after both memory services answer in an isolated environment. Smoke-test one manual processing call there before production credentials are enabled.

Rollback of this service is a compatible redeploy. Do not drop `chat_memory` or reset row statuses as a routine rollback. A schema change requires a coordinated contract revision across the memory services and the bot.

## Limits

agent-bot's background save is best-effort. If this database is unavailable, the bot can miss a save, and this service cannot make that unacknowledged call durable. There is no ingestion queue or automatic retry.

Very large messages can exhaust the exchange or deadline budget. They remain stored and pending. Adjusting the documented limits cannot raise the contract maximums of 100 rows, 64,000 code points, 16 exchanges, or 240 seconds. Another explicit processing call is required after a failure.

Live DeepSeek quality is not measured by the default test suite. `CHAT_MEMORY_LIVE_DEEPSEEK=1 pnpm test:live` runs a non-sensitive smoke test when an API key is available. A passing unit test does not prove subjective summary quality.
