import "server-only";
import type { PoolClient } from "pg";
import { ServiceError } from "../http/errors";
import {
  codePointLength,
  SUMMARY_MAX_CODE_POINTS,
  type CapturedMessage,
} from "./contracts";
import {
  completeCapturedMessages,
  lockChatForFinalize,
  writeSummary,
} from "./repository";

export type FinalizeHooks = {
  afterSummaryUpdate?: (client: PoolClient) => Promise<void>;
};

export function validateFinalSummary(summary: string): string {
  const text = summary.trim();
  if (text.length === 0 || text.includes("\u0000")) {
    throw new ServiceError(502, "SUMMARIZATION_FAILED", true);
  }
  if (codePointLength(text) > SUMMARY_MAX_CODE_POINTS) {
    throw new ServiceError(502, "SUMMARIZATION_FAILED", true);
  }
  return text;
}

export async function finalizeClaim(
  client: PoolClient,
  input: {
    telegramChatId: string;
    token: string;
    summaryVersion: string;
    summaryText: string;
    captured: CapturedMessage[];
  },
  hooks: FinalizeHooks = {},
): Promise<{ summaryVersion: string }> {
  const summaryText = validateFinalSummary(input.summaryText);
  const locked = await lockChatForFinalize(client, input.telegramChatId);
  if (
    !locked ||
    !locked.leaseActive ||
    locked.processingToken !== input.token ||
    locked.summaryVersion !== input.summaryVersion
  ) {
    throw new ServiceError(500, "FENCE_REJECTED", false);
  }
  const summaryVersion = await writeSummary(client, {
    telegramChatId: input.telegramChatId,
    token: input.token,
    summaryVersion: input.summaryVersion,
    summaryText,
  });
  if (hooks.afterSummaryUpdate) await hooks.afterSummaryUpdate(client);
  const updated = await completeCapturedMessages(client, {
    telegramChatId: input.telegramChatId,
    rawMessageIds: input.captured.map((message) => message.rawMessageId),
    summaryVersion,
  });
  if (updated !== input.captured.length) {
    throw new ServiceError(500, "FENCE_REJECTED", false);
  }
  return { summaryVersion };
}
