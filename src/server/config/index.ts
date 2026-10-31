import { z } from "zod";
import {
  DEFAULT_BATCH_MAX_CHARACTERS,
  DEFAULT_BATCH_MAX_MESSAGES,
  PROCESS_DEADLINE_MS,
} from "../chat-memory/contracts";
import { ServiceError } from "../http/errors";
import { readDatabaseConfig, type DatabaseConfig } from "../postgres/config";

const tokenSchema = z.string().trim().min(16).max(512);

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function boundedInt(fallback: number, max: number) {
  return z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : value),
    z.coerce.number().int().positive().max(max),
  );
}

const sharedSchema = z
  .object({
    CHAT_MEMORY_INGEST_TOKEN: tokenSchema,
    CHAT_MEMORY_PROCESS_TOKEN: tokenSchema,
    CHAT_MEMORY_READ_TOKEN: tokenSchema.optional(),
  })
  .superRefine((value, context) => {
    const tokens = [
      value.CHAT_MEMORY_INGEST_TOKEN,
      value.CHAT_MEMORY_PROCESS_TOKEN,
      value.CHAT_MEMORY_READ_TOKEN,
    ].filter((token): token is string => token !== undefined);
    if (new Set(tokens).size !== tokens.length) {
      context.addIssue({
        code: "custom",
        message: "memory tokens must be distinct",
        path: ["CHAT_MEMORY_PROCESS_TOKEN"],
      });
    }
  });

const processSchema = sharedSchema.safeExtend({
  DEEPSEEK_API_KEY: z.string().trim().min(1),
  DEEPSEEK_BASE_URL: z.preprocess(
    (value) =>
      value === undefined || value === "" ? "https://api.deepseek.com" : value,
    z
      .string()
      .trim()
      .pipe(z.url({ protocol: /^https$/ }))
      .transform((value) => value.replace(/\/+$/, "")),
  ),
  DEEPSEEK_SUMMARY_MODEL: z.preprocess(
    (value) =>
      value === undefined || value === "" ? "deepseek-v4-pro" : value,
    z.string().trim().min(1).max(128),
  ),
  MEMORY_PROCESS_TIMEOUT_MS: boundedInt(
    PROCESS_DEADLINE_MS,
    PROCESS_DEADLINE_MS,
  ),
  MEMORY_BATCH_MAX_MESSAGES: boundedInt(
    DEFAULT_BATCH_MAX_MESSAGES,
    DEFAULT_BATCH_MAX_MESSAGES,
  ),
  MEMORY_BATCH_MAX_CHARACTERS: boundedInt(
    DEFAULT_BATCH_MAX_CHARACTERS,
    DEFAULT_BATCH_MAX_CHARACTERS,
  ),
});

export type IngestConfig = DatabaseConfig & z.infer<typeof sharedSchema>;
export type ProcessConfig = DatabaseConfig & z.infer<typeof processSchema>;

function configurationUnavailable(): never {
  throw new ServiceError(503, "CONFIGURATION_UNAVAILABLE", false);
}

function tokenFields(env: Record<string, string | undefined>) {
  return {
    CHAT_MEMORY_INGEST_TOKEN: blankToUndefined(env.CHAT_MEMORY_INGEST_TOKEN),
    CHAT_MEMORY_PROCESS_TOKEN: blankToUndefined(env.CHAT_MEMORY_PROCESS_TOKEN),
    CHAT_MEMORY_READ_TOKEN: blankToUndefined(env.CHAT_MEMORY_READ_TOKEN),
  };
}

export function readIngestConfig(
  env: Record<string, string | undefined> = process.env,
): IngestConfig {
  let database: DatabaseConfig;
  try {
    database = readDatabaseConfig(env);
  } catch {
    configurationUnavailable();
  }
  const parsed = sharedSchema.safeParse(tokenFields(env));
  if (!parsed.success) configurationUnavailable();
  return { ...database, ...parsed.data };
}

export function readProcessConfig(
  env: Record<string, string | undefined> = process.env,
): ProcessConfig {
  let database: DatabaseConfig;
  try {
    database = readDatabaseConfig(env);
  } catch {
    configurationUnavailable();
  }
  const parsed = processSchema.safeParse({
    ...tokenFields(env),
    DEEPSEEK_API_KEY: blankToUndefined(env.DEEPSEEK_API_KEY),
    DEEPSEEK_BASE_URL: blankToUndefined(env.DEEPSEEK_BASE_URL),
    DEEPSEEK_SUMMARY_MODEL: blankToUndefined(env.DEEPSEEK_SUMMARY_MODEL),
    MEMORY_PROCESS_TIMEOUT_MS: blankToUndefined(env.MEMORY_PROCESS_TIMEOUT_MS),
    MEMORY_BATCH_MAX_MESSAGES: blankToUndefined(env.MEMORY_BATCH_MAX_MESSAGES),
    MEMORY_BATCH_MAX_CHARACTERS: blankToUndefined(
      env.MEMORY_BATCH_MAX_CHARACTERS,
    ),
  });
  if (!parsed.success) configurationUnavailable();
  return { ...database, ...parsed.data };
}

export function readHealthConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  try {
    return readDatabaseConfig(env);
  } catch {
    configurationUnavailable();
  }
}
