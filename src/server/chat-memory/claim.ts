import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ServiceError } from "../http/errors";
import {
  codePointLength,
  LEASE_SECONDS,
  type CapturedMessage,
} from "./contracts";
import {
  hasAnyPending,
  listOldestPending,
  listPendingChats,
  lockChat,
  selectCapturedPrefix,
  setProcessingLease,
} from "./repository";

export type ClaimedBatch = {
  kind: "claimed";
  telegramChatId: string;
  summaryText: string;
  summaryVersion: string;
  processingToken: string;
  captured: CapturedMessage[];
  capturedCharacters: number;
};

export type ClaimOutcome =
  { kind: "no_work" } | { kind: "no_eligible_chat" } | ClaimedBatch;

export async function claimOneChat(
  client: PoolClient,
  limits: { maxMessages: number; maxCharacters: number; leaseSeconds?: number },
): Promise<ClaimOutcome> {
  if (!(await hasAnyPending(client))) return { kind: "no_work" };
  const candidates = await listPendingChats(client);
  for (const candidate of candidates) {
    await client.query("SAVEPOINT claim_candidate");
    try {
      const locked = await lockChat(client, candidate.telegramChatId);
      if (!locked || locked.leaseActive) {
        await releaseCandidate(client, false);
        continue;
      }
      const pending = await listOldestPending(
        client,
        locked.telegramChatId,
        limits.maxMessages,
      );
      const captured = selectCapturedPrefix(
        pending,
        limits.maxMessages,
        limits.maxCharacters,
      );
      if (captured.length === 0) {
        await releaseCandidate(client, false);
        continue;
      }
      const token = randomUUID();
      await setProcessingLease(
        client,
        locked.telegramChatId,
        token,
        limits.leaseSeconds ?? LEASE_SECONDS,
      );
      await releaseCandidate(client, true);
      return {
        kind: "claimed",
        telegramChatId: locked.telegramChatId,
        summaryText: locked.summaryText,
        summaryVersion: locked.summaryVersion,
        processingToken: token,
        captured,
        capturedCharacters: captured.reduce(
          (total, message) => total + codePointLength(message.content),
          0,
        ),
      };
    } catch (error) {
      await releaseCandidate(client, false);
      throw error;
    }
  }
  if (await hasAnyPending(client)) return { kind: "no_eligible_chat" };
  return { kind: "no_work" };
}

async function releaseCandidate(
  client: PoolClient,
  keep: boolean,
): Promise<void> {
  if (!keep) await client.query("ROLLBACK TO SAVEPOINT claim_candidate");
  await client.query("RELEASE SAVEPOINT claim_candidate");
}

export function assertClaimCaptured(claim: ClaimedBatch): void {
  if (claim.captured.length === 0) {
    throw new ServiceError(500, "INTERNAL_ERROR", false);
  }
}
