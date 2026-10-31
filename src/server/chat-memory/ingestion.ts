import "server-only";
import type { Pool } from "pg";
import { withTransaction } from "../postgres/client";
import type { IngestInput } from "./contracts";
import { insertRawMessage, type StoredMessage } from "./repository";

export async function ingestMessage(
  pool: Pool,
  input: IngestInput,
): Promise<StoredMessage> {
  return withTransaction(pool, (client) => insertRawMessage(client, input));
}
