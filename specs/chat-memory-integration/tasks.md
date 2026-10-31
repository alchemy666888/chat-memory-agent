# chat-memory-agent tasks

| Task | Status | Evidence |
|---|---|---|
| TASK-001 | Complete | Next.js/pnpm/TypeScript scaffold matches the agent-bot core stack. `pnpm install --frozen-lockfile`, `pnpm typecheck`, and `pnpm build` succeed without production credentials. |
| TASK-002 | Complete | Zod wire contracts, Unicode code-point limits, distinct bearer scopes, and environment validation. Covered by `tests/unit/contracts-and-auth.test.ts` and `tests/unit/body-and-commit.test.ts`. |
| TASK-003 | Complete | `migrations/0001_chat_memory.sql`, catalog manifest, and `pnpm db:init`. Repeat initialization passes. A conflicting summary check fails. Runtime handlers contain no DDL. |
| TASK-004 | Complete | Idempotent ingestion, assistant-first delivery, concurrent duplicates, and content conflicts. Covered by the PostgreSQL ingestion test. |
| TASK-005 | Complete | Single-chat `FOR UPDATE SKIP LOCKED` claim, bounded prefix, active lease, expired lease, and two-chat concurrency. |
| TASK-006 | Complete | DeepSeek `/responses` client with thinking disabled and no tools. Deferred fixtures cover incomplete, over-limit, repair, and exchange-budget failures. No live call in the default suite. |
| TASK-007 | Complete | Fenced finalization rolls back when row completion fails. Stale tokens cannot commit or clear a newer lease. Provider failure leaves the previous summary pending. |
| TASK-008 | Complete | Ingest, process, and health routes enforce method body, media type, and token scope. Invalid credentials do not open a database connection or call the model. |
| TASK-009 | Complete | Real PostgreSQL tests cover locks, permission denial, repeatable-read snapshot isolation, unusual identity commit order, and `COMMIT_OUTCOME_UNKNOWN`. MCP read example counts are computed in `tests/contracts/shared-contract.test.ts`. |
| TASK-010 | Complete | `README.md`, `docs/chat-memory-contract-v1.md`, and `docs/operations.md` document initialization, best-effort bot saves, ambiguous commits, and manual triggers. |

Traceability: REQ-F-001/002 to TASK-004; REQ-F-003/010 to TASK-003; REQ-F-004/005 to TASK-005/008; REQ-F-006 to TASK-006; REQ-F-007/008 to TASK-007/009; REQ-F-009 to TASK-005/007/009; REQ-NF-001 to TASK-004/005/007; REQ-NF-002 to TASK-002/006/010; REQ-NF-003 to TASK-002/003/008/009.

Live DeepSeek quality smoke (`pnpm test:live`) was not run. It needs `CHAT_MEMORY_LIVE_DEEPSEEK=1` and a real API key, and it is not evidence of subjective summary quality by itself.
