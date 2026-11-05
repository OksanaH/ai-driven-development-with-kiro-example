/**
 * Shared utilities used across pipeline stages.
 */

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes.
 *
 * Uses a Buffer so the cut happens on a byte boundary. A trailing multi-byte
 * character split by the cut is dropped so the result stays valid UTF-8.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  return buffer.subarray(0, maxBytes).toString("utf8");
}
