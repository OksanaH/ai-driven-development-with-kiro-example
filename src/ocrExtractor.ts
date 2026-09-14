/**
 * Text-extraction stage for a single JPEG image.
 *
 * Runs the uploaded image through Amazon Textract's synchronous
 * `DetectDocumentTextCommand` (one call), retrying only on transient errors up
 * to 2 additional times — 3 attempts total (Requirement 4.1). If the image
 * still fails after retries, the stage fails with a "text extraction failed"
 * error and the Summarizer is not invoked (4.2). The detected `LINE` blocks are
 * joined into a single Extracted_Text; if that text has no non-whitespace
 * character the stage fails with a "no text extracted" error (4.3).
 */

import {
  DetectDocumentTextCommand,
  TextractClient,
} from "@aws-sdk/client-textract";

import type { Result, StageError } from "./types";

const STAGE = "text-extraction" as const;

/** Maximum number of *additional* attempts after the initial call (4.1). */
const MAX_RETRIES = 2;

/**
 * A transient error is one worth retrying: throttling, a 5xx from the service,
 * or a network-level failure. Everything else (e.g. an unreadable image) is
 * permanent and is not retried.
 */
function isTransientError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }

  const anyErr = err as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  // Throttling: SDK surfaces these by name (e.g. ThrottlingException).
  if (anyErr.name && anyErr.name.includes("Throttling")) {
    return true;
  }

  // Server-side (5xx) responses are transient and worth retrying.
  const status = anyErr.$metadata?.httpStatusCode;
  if (typeof status === "number" && status >= 500) {
    return true;
  }

  // Network-level failures (no HTTP status reached) — common Node error codes.
  const networkCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EPIPE",
    "EAI_AGAIN",
  ]);
  if (anyErr.code && networkCodes.has(anyErr.code)) {
    return true;
  }

  return false;
}

/** Join the `LINE`-type blocks of a Textract response into a single string. */
function linesFromResponse(response: {
  Blocks?: { BlockType?: string; Text?: string }[];
}): string {
  const blocks = response.Blocks ?? [];
  return blocks
    .filter((block) => block.BlockType === "LINE" && typeof block.Text === "string")
    .map((block) => block.Text as string)
    .join("\n");
}

/**
 * Extract text from a single JPEG image via Amazon Textract.
 *
 * Issues one `DetectDocumentTextCommand` with the image bytes, retrying only on
 * transient errors up to `MAX_RETRIES` additional times (3 attempts total)
 * (4.1). If the call still fails, the stage returns a "text extraction failed"
 * error so the pipeline stops before the Summarizer (4.2). On success the
 * detected `LINE` blocks are joined into the Extracted_Text; if it contains no
 * non-whitespace character the stage returns a "no text extracted" error (4.3).
 */
export async function extractFromImage(
  bytes: Uint8Array,
  textract: TextractClient
): Promise<Result<string, StageError>> {
  let text: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await textract.send(
        new DetectDocumentTextCommand({ Document: { Bytes: bytes } })
      );
      text = linesFromResponse(response);
      break;
    } catch (err) {
      // Only keep retrying while the error is transient and attempts remain.
      if (!isTransientError(err) || attempt === MAX_RETRIES) {
        return {
          ok: false,
          error: { stage: STAGE, message: "text extraction failed" },
        };
      }
    }
  }

  // If the detected text has no non-whitespace character, the stage fails with
  // a "no text extracted" error (4.3).
  if (text === undefined || text.trim().length === 0) {
    return {
      ok: false,
      error: { stage: STAGE, message: "no text extracted" },
    };
  }

  return { ok: true, value: text };
}
