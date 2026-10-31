import { randomUUID } from "node:crypto";
import { CONTRACT_VERSION } from "../chat-memory/contracts";
import {
  CommitOutcomeUnknownError,
  isDatabaseUnavailable,
  ServiceError,
} from "./errors";

export function requestIdFrom(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && /^[A-Za-z0-9_.:-]{1,128}$/.test(supplied)) return supplied;
  return randomUUID();
}

export function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    },
  });
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ServiceError) {
    return jsonResponse(
      error.status,
      {
        contract_version: CONTRACT_VERSION,
        error: { code: error.errorCode, retryable: error.retryable },
        request_id: requestId,
      },
      requestId,
    );
  }
  if (error instanceof CommitOutcomeUnknownError) {
    return jsonResponse(
      500,
      {
        contract_version: CONTRACT_VERSION,
        error: { code: "COMMIT_OUTCOME_UNKNOWN", retryable: false },
        request_id: requestId,
      },
      requestId,
    );
  }
  if (isDatabaseUnavailable(error)) {
    return jsonResponse(
      503,
      {
        contract_version: CONTRACT_VERSION,
        error: { code: "DATABASE_UNAVAILABLE", retryable: true },
        request_id: requestId,
      },
      requestId,
    );
  }
  return jsonResponse(
    500,
    {
      contract_version: CONTRACT_VERSION,
      error: { code: "INTERNAL_ERROR", retryable: false },
      request_id: requestId,
    },
    requestId,
  );
}
