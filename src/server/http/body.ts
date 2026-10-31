import { ServiceError } from "./errors";

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim();
  if (mediaType?.toLowerCase() !== "application/json") {
    throw new ServiceError(415, "UNSUPPORTED_MEDIA_TYPE", false);
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
  ) {
    throw new ServiceError(413, "PAYLOAD_TOO_LARGE", false);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError(400, "INVALID_INPUT", false);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ServiceError(413, "PAYLOAD_TOO_LARGE", false);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(400, "INVALID_INPUT", false);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.includes("\u0000"))
    throw new ServiceError(400, "INVALID_INPUT", false);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServiceError(400, "INVALID_INPUT", false);
  }
}
