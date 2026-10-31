import {
  CommitOutcomeUnknownError,
  errorCodeOf,
  isDatabaseUnavailable,
  ServiceError,
} from "./errors";

export type DiagnosticEvent = {
  request_id: string;
  phase: string;
  duration_ms?: number;
  result?: string;
  code?: string;
  telegram_chat_id?: string;
  captured_rows?: number;
  captured_characters?: number;
  summary_version?: string;
  model?: string;
  provider_request_id?: string;
  lease?: string;
  chunk_count?: number;
  exchanges?: number;
};

const SAFE_PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function logDiagnostic(event: DiagnosticEvent): void {
  const providerRequestId =
    event.provider_request_id &&
    SAFE_PROVIDER_ID.test(event.provider_request_id)
      ? event.provider_request_id
      : undefined;
  const payload = {
    service: "chat-memory-agent",
    timestamp: new Date().toISOString(),
    request_id: event.request_id,
    phase: event.phase,
    ...(event.duration_ms === undefined
      ? {}
      : { duration_ms: event.duration_ms }),
    ...(event.result === undefined ? {} : { result: event.result }),
    ...(event.code === undefined ? {} : { code: event.code }),
    ...(event.telegram_chat_id === undefined
      ? {}
      : { telegram_chat_id: event.telegram_chat_id }),
    ...(event.captured_rows === undefined
      ? {}
      : { captured_rows: event.captured_rows }),
    ...(event.captured_characters === undefined
      ? {}
      : { captured_characters: event.captured_characters }),
    ...(event.summary_version === undefined
      ? {}
      : { summary_version: event.summary_version }),
    ...(event.model === undefined ? {} : { model: event.model }),
    ...(providerRequestId === undefined
      ? {}
      : { provider_request_id: providerRequestId }),
    ...(event.lease === undefined ? {} : { lease: event.lease }),
    ...(event.chunk_count === undefined
      ? {}
      : { chunk_count: event.chunk_count }),
    ...(event.exchanges === undefined ? {} : { exchanges: event.exchanges }),
  };
  console.log(JSON.stringify(payload));
}

export function logFailureClass(requestId: string, code: string): void {
  logDiagnostic({ request_id: requestId, phase: "failure", code });
}

export function publicFailureCode(error: unknown): string {
  if (error instanceof ServiceError) return error.errorCode;
  if (error instanceof CommitOutcomeUnknownError)
    return "COMMIT_OUTCOME_UNKNOWN";
  if (isDatabaseUnavailable(error)) return "DATABASE_UNAVAILABLE";
  const code = errorCodeOf(error);
  if (code && /^[0-9A-Z]{5}$/.test(code)) return code;
  return "INTERNAL_ERROR";
}
