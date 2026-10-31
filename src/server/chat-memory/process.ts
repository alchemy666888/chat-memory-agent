import "server-only";
import type { Pool } from "pg";
import type { ModelCompletion, ModelExchange } from "../deepseek/client";
import { summarizeBatch, type DeadlineBudget } from "../deepseek/summarize";
import { CommitOutcomeUnknownError, ServiceError } from "../http/errors";
import { logDiagnostic, type DiagnosticEvent } from "../http/logging";
import { withTransaction } from "../postgres/client";
import { claimOneChat, type ClaimedBatch } from "./claim";
import {
  EXCHANGE_TIMEOUT_MS,
  FINALIZE_RESERVE_MS,
  type ProcessResponse,
} from "./contracts";
import { finalizeClaim, type FinalizeHooks } from "./finalize";
import { chatHasPending, clearProcessingLease } from "./repository";

export type ProcessDependencies = {
  pool: Pool;
  requestId: string;
  modelName: string;
  complete: (exchange: ModelExchange) => Promise<ModelCompletion>;
  maxMessages: number;
  maxCharacters: number;
  deadlineMs: number;
  now?: () => number;
  reserveMs?: number;
  exchangeCapMs?: number;
  chunkLimit?: number;
  hooks?: FinalizeHooks;
};

export function createDeadline(
  now: () => number,
  deadlineMs: number,
  reserveMs = FINALIZE_RESERVE_MS,
  exchangeCapMs = EXCHANGE_TIMEOUT_MS,
): DeadlineBudget & { startedAt: number } {
  const startedAt = now();
  const endsAt = startedAt + deadlineMs;
  return {
    startedAt,
    reserveMs,
    remainingMs: () => endsAt - now(),
    nextExchangeTimeoutMs: () => {
      const available = endsAt - now() - reserveMs;
      if (available <= 0)
        throw new ServiceError(504, "DEADLINE_EXCEEDED", true);
      return Math.min(exchangeCapMs, available);
    },
  };
}

export async function processNextChat(
  deps: ProcessDependencies,
): Promise<ProcessResponse> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = createDeadline(
    now,
    deps.deadlineMs,
    deps.reserveMs,
    deps.exchangeCapMs,
  );
  const claimStarted = now();
  const claim = await withTransaction(deps.pool, (client) =>
    claimOneChat(client, {
      maxMessages: deps.maxMessages,
      maxCharacters: deps.maxCharacters,
    }),
  );
  logDiagnostic({
    request_id: deps.requestId,
    phase: "claim",
    duration_ms: now() - claimStarted,
    result: claim.kind,
    ...(claim.kind === "claimed"
      ? {
          telegram_chat_id: claim.telegramChatId,
          captured_rows: claim.captured.length,
          captured_characters: claim.capturedCharacters,
          summary_version: claim.summaryVersion,
          lease: "acquired",
        }
      : { lease: claim.kind }),
  });
  if (claim.kind !== "claimed") {
    return {
      contract_version: 1,
      result: claim.kind,
      processed_messages: 0,
    };
  }

  try {
    const summaryStarted = now();
    let providerRequestId: string | undefined;
    const summary = await summarizeBatch({
      previousSummary: claim.summaryText,
      messages: claim.captured,
      model: { complete: deps.complete },
      deadline,
      ...(deps.chunkLimit === undefined ? {} : { chunkLimit: deps.chunkLimit }),
      onExchange: (event) => {
        providerRequestId = event.providerRequestId ?? providerRequestId;
      },
    });
    logDiagnostic({
      request_id: deps.requestId,
      phase: "summarize",
      duration_ms: now() - summaryStarted,
      telegram_chat_id: claim.telegramChatId,
      model: summary.model ?? deps.modelName,
      ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
      chunk_count: summary.chunkCount,
      exchanges: summary.exchanges,
      result: "completed",
    });
    const finalizeStarted = now();
    const finalized = await withTransaction(deps.pool, (client) =>
      finalizeClaim(
        client,
        {
          telegramChatId: claim.telegramChatId,
          token: claim.processingToken,
          summaryVersion: claim.summaryVersion,
          summaryText: summary.text,
          captured: claim.captured,
        },
        deps.hooks,
      ),
    );
    let hasMore = true;
    try {
      hasMore = await chatHasPending(deps.pool, claim.telegramChatId);
    } catch {
      logDiagnostic({
        request_id: deps.requestId,
        phase: "pending-check",
        code: "PENDING_CHECK_FAILED",
        telegram_chat_id: claim.telegramChatId,
      });
    }
    logDiagnostic({
      request_id: deps.requestId,
      phase: "finalize",
      duration_ms: now() - finalizeStarted,
      result: "processed",
      telegram_chat_id: claim.telegramChatId,
      captured_rows: claim.captured.length,
      summary_version: finalized.summaryVersion,
      lease: "cleared",
    });
    logDiagnostic({
      request_id: deps.requestId,
      phase: "request",
      duration_ms: now() - started,
      result: "processed",
      telegram_chat_id: claim.telegramChatId,
    });
    return {
      contract_version: 1,
      result: "processed",
      telegram_chat_id: claim.telegramChatId,
      processed_messages: claim.captured.length,
      summary_version: finalized.summaryVersion,
      has_more_pending: hasMore,
    };
  } catch (error) {
    await releaseOwnedLease(deps, claim, error);
    logDiagnostic(
      failureEvent(
        deps.requestId,
        claim.telegramChatId,
        error,
        now() - started,
      ),
    );
    throw error;
  }
}

async function releaseOwnedLease(
  deps: ProcessDependencies,
  claim: ClaimedBatch,
  error: unknown,
): Promise<void> {
  if (error instanceof CommitOutcomeUnknownError) {
    logDiagnostic({
      request_id: deps.requestId,
      phase: "lease",
      lease: "retained_commit_unknown",
      telegram_chat_id: claim.telegramChatId,
      code: "COMMIT_OUTCOME_UNKNOWN",
    });
    return;
  }
  try {
    const cleared = await withTransaction(deps.pool, (client) =>
      clearProcessingLease(client, claim.telegramChatId, claim.processingToken),
    );
    logDiagnostic({
      request_id: deps.requestId,
      phase: "lease",
      lease: cleared ? "cleared" : "not_owner",
      telegram_chat_id: claim.telegramChatId,
    });
  } catch (clearError) {
    logDiagnostic({
      request_id: deps.requestId,
      phase: "lease",
      lease:
        clearError instanceof CommitOutcomeUnknownError
          ? "clear_outcome_unknown"
          : "clear_failed",
      code:
        clearError instanceof CommitOutcomeUnknownError
          ? "COMMIT_OUTCOME_UNKNOWN"
          : "LEASE_CLEAR_FAILED",
      telegram_chat_id: claim.telegramChatId,
    });
  }
}

function failureEvent(
  requestId: string,
  telegramChatId: string,
  error: unknown,
  durationMs: number,
): DiagnosticEvent {
  const code =
    error instanceof ServiceError
      ? error.errorCode
      : error instanceof CommitOutcomeUnknownError
        ? "COMMIT_OUTCOME_UNKNOWN"
        : "INTERNAL_ERROR";
  return {
    request_id: requestId,
    phase: "request",
    duration_ms: durationMs,
    result: "failed",
    code,
    telegram_chat_id: telegramChatId,
  };
}
