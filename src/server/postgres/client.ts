import { Pool, type PoolClient, type PoolConfig } from "pg";
import { POOL_MAX } from "../chat-memory/contracts";
import { CommitOutcomeUnknownError, isConnectionLoss } from "../http/errors";
import { normalizePostgresUrl, type DatabaseConfig } from "./config";

export type Queryable = Pick<PoolClient, "query">;

/**
 * Builds a TLS configuration without allowing URL SSL options to replace the CA.
 * The pool stays at 3 connections per warm instance. Do not parse bigint as Number.
 */
export function postgresPoolConfig(
  connectionString: string,
  certificateAuthority?: string,
): PoolConfig {
  if (!certificateAuthority) {
    return {
      connectionString,
      max: POOL_MAX,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 10_000,
    };
  }
  const url = new URL(connectionString);
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(parameter);
  }
  return {
    connectionString: url.toString(),
    max: POOL_MAX,
    allowExitOnIdle: true,
    connectionTimeoutMillis: 10_000,
    ssl: { ca: certificateAuthority, rejectUnauthorized: true },
  };
}

export function createPool(config: DatabaseConfig): Pool {
  return new Pool(postgresPoolConfig(config.DATABASE_URL, config.AIVEN_PG_CA));
}

const globalPools = globalThis as unknown as {
  __chatMemoryPools?: Map<string, Pool>;
};

export function getPool(config: DatabaseConfig): Pool {
  const pools = (globalPools.__chatMemoryPools ??= new Map());
  const key = `${config.DATABASE_URL}\n${config.AIVEN_PG_CA ?? ""}`;
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = createPool(config);
  pools.set(key, pool);
  return pool;
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let began = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await fn(client);
    try {
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      if (isConnectionLoss(error)) throw new CommitOutcomeUnknownError();
      throw error;
    }
    return result;
  } catch (error) {
    if (began && !committed && !(error instanceof CommitOutcomeUnknownError)) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A lost connection cannot confirm rollback. COMMIT failures are
        // already classified; earlier statement failures leave the transaction
        // uncommitted when PostgreSQL drops the session.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export function assertRuntimeUrl(connectionString: string): string {
  return normalizePostgresUrl(connectionString);
}
