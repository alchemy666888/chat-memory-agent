import { z } from "zod";

/**
 * Keep node-postgres on its current, strict TLS behavior without relying on
 * sslmode aliases whose meaning changes in pg v9.
 *
 * Vercel stores pasted PEMs with literal "\n", and a real multiline value
 * cannot travel in a sandbox command environment without splitting later
 * variables. Callers that forward this to another process base64-encode it.
 */
export function normalizeCertificate(value: string): string {
  const expanded = value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  const trimmed = expanded.trim();
  if (trimmed.includes("BEGIN CERTIFICATE")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (decoded.includes("BEGIN CERTIFICATE")) return decoded;
  return trimmed;
}

export function normalizePostgresUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
  const usesLibpqCompatibility =
    url.searchParams.get("uselibpqcompat")?.toLowerCase() === "true";
  if (
    !usesLibpqCompatibility &&
    ["prefer", "require", "verify-ca"].includes(sslmode ?? "")
  ) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

const databaseSchema = z.object({
  DATABASE_URL: z
    .string()
    .trim()
    .min(1)
    .pipe(z.url({ protocol: /^postgres(ql)?$/ }))
    .transform(normalizePostgresUrl),
  AIVEN_PG_CA: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((value) =>
      value === undefined ? undefined : normalizeCertificate(value),
    ),
});

export type DatabaseConfig = z.infer<typeof databaseSchema>;

export function readDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  return databaseSchema.parse({
    DATABASE_URL: env.DATABASE_URL,
    AIVEN_PG_CA: blankToUndefined(env.AIVEN_PG_CA),
  });
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
