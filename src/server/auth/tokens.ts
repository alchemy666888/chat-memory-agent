import { createHash, timingSafeEqual } from "node:crypto";
import { ServiceError } from "../http/errors";

export function tokenEquals(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function authenticateBearer(
  authorization: string | null,
  expected: string,
  otherTokens: string[],
): void {
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    throw new ServiceError(401, "UNAUTHORIZED", false);
  }
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (tokenEquals(token, expected)) return;
  if (otherTokens.some((candidate) => tokenEquals(token, candidate))) {
    throw new ServiceError(403, "FORBIDDEN", false);
  }
  throw new ServiceError(401, "UNAUTHORIZED", false);
}
