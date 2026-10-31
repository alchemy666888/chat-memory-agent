import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const root = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const migrationPath = join(root, "migrations", "0001_chat_memory.sql");
const manifestPath = join(root, "migrations", "0001_chat_memory.manifest.json");

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function fail(message) {
  console.error(redact(message));
  process.exit(1);
}

function redact(message) {
  return String(message).replace(
    /postgres(?:ql)?:\/\/\S+/gi,
    "postgresql://redacted",
  );
}

function normalizeCertificate(value) {
  const expanded = value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  const trimmed = expanded.trim();
  if (trimmed.includes("BEGIN CERTIFICATE")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (decoded.includes("BEGIN CERTIFICATE")) return decoded;
  return trimmed;
}

function normalizePostgresUrl(connectionString) {
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

function poolConfig(connectionString, certificateAuthority) {
  if (!certificateAuthority) return { connectionString, max: 1 };
  const url = new URL(connectionString);
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(parameter);
  }
  return {
    connectionString: url.toString(),
    max: 1,
    ssl: { ca: certificateAuthority, rejectUnauthorized: true },
  };
}

async function loadCatalog(client) {
  const columns = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default,
            is_identity, identity_generation
     FROM information_schema.columns
     WHERE table_schema = 'chat_memory'
     ORDER BY table_name, ordinal_position`,
  );
  const constraints = await client.query(
    `SELECT c.conname AS name, r.relname AS table_name, pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_class r ON r.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'chat_memory'
     ORDER BY c.conname`,
  );
  const indexes = await client.query(
    `SELECT indexname AS name, indexdef AS definition
     FROM pg_indexes
     WHERE schemaname = 'chat_memory'
     ORDER BY indexname`,
  );
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  };
}

async function grantRole(client, role, tablePrivileges, includeSequence) {
  if (!ROLE_NAME.test(role)) fail(`invalid role name: ${role}`);
  const exists = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [role],
  );
  if (exists.rowCount !== 1) {
    fail(
      `role ${role} does not exist. Create it before initialization and grant no DDL to the runtime or MCP roles.`,
    );
  }
  const quoted = (await client.query("SELECT quote_ident($1) AS ident", [role]))
    .rows[0].ident;
  await client.query(`GRANT USAGE ON SCHEMA chat_memory TO ${quoted}`);
  await client.query(
    `GRANT ${tablePrivileges} ON chat_memory.chat_memories TO ${quoted}`,
  );
  await client.query(
    `GRANT ${tablePrivileges} ON chat_memory.raw_messages TO ${quoted}`,
  );
  if (includeSequence) {
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA chat_memory TO ${quoted}`,
    );
  }
}

async function main() {
  const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
  if (!migratorUrl)
    fail("DATABASE_MIGRATOR_URL is required for explicit initialization");
  const certificate =
    process.env.AIVEN_PG_CA && process.env.AIVEN_PG_CA.trim() !== ""
      ? normalizeCertificate(process.env.AIVEN_PG_CA)
      : undefined;
  const pool = new Pool(
    poolConfig(normalizePostgresUrl(migratorUrl), certificate),
  );
  const client = await pool.connect();
  try {
    const sql = readFileSync(migrationPath, "utf8");
    await client.query(sql);
    await client.query("REVOKE ALL ON SCHEMA chat_memory FROM PUBLIC");
    await client.query(
      "REVOKE ALL ON ALL TABLES IN SCHEMA chat_memory FROM PUBLIC",
    );
    const runtimeRole = process.env.CHAT_MEMORY_RUNTIME_ROLE;
    const mcpRole = process.env.CHAT_MEMORY_MCP_ROLE;
    if (!runtimeRole || !mcpRole) {
      console.error(
        "CHAT_MEMORY_RUNTIME_ROLE and CHAT_MEMORY_MCP_ROLE are unset. Tables were created without grants. Create both roles, then rerun pnpm db:init. The runtime role needs SELECT, INSERT, UPDATE and identity sequence usage. The MCP role needs USAGE on schema chat_memory and SELECT only.",
      );
    } else {
      await grantRole(client, runtimeRole, "SELECT, INSERT, UPDATE", true);
      await grantRole(client, mcpRole, "SELECT", false);
    }
    const catalog = await loadCatalog(client);
    if (process.argv.includes("--dump-manifest")) {
      process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
      return;
    }
    const expected = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (JSON.stringify(catalog) !== JSON.stringify(expected)) {
      fail(
        "schema compatibility check failed. The database does not match migrations/0001_chat_memory.manifest.json. Refusing to alter a conflicting schema.",
      );
    }
    console.log(
      "chat_memory schema is present and compatible with contract v1",
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : "";
  fail(`database initialization failed${code ? ` (${code})` : ""}`);
});
