export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    readonly retryable: boolean,
  ) {
    super(errorCode);
  }
}

export class CommitOutcomeUnknownError extends Error {
  readonly errorCode = "COMMIT_OUTCOME_UNKNOWN";

  constructor() {
    super("COMMIT_OUTCOME_UNKNOWN");
  }
}

const CONNECTION_LOSS_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08003",
  "08006",
  "08001",
  "53300",
]);

export function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error))
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isConnectionLoss(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code && CONNECTION_LOSS_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : "";
  return /connection terminated|Connection terminated|socket hang up|ECONNRESET|Client has encountered a connection error/i.test(
    message,
  );
}

export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof CommitOutcomeUnknownError) return false;
  if (isConnectionLoss(error)) return true;
  const code = errorCodeOf(error);
  return (
    code === "40001" || code === "40P01" || code === "55P03" || code === "53300"
  );
}
