/**
 * Text-extraction stage for image archives.
 *
 * Runs each supported image through Amazon Textract's synchronous
 * `DetectDocumentTextCommand` (one call per image), retrying only on transient
 * errors up to 2 additional times (Requirement 4.1). Excluded entries are
 * never sent to the OCR service (4.5). Images that still fail after retries are
 * recorded in `imageFailures` and processing continues with the rest (4.3).
 *
 * Per-image text is aggregated in ascending order of entry name, separated by
 * a newline, into a single Extracted_Text (4.2). If no image yields any
 * non-whitespace text, the stage fails with a "no text was extracted" error
 * (4.4).
 */

import {
  DetectDocumentTextCommand,
  TextractClient,
} from "@aws-sdk/client-textract";

import type {
  ArchiveImage,
  ExcludedEntry,
  ExtractionResult,
  ImageFailure,
  Result,
  StageError,
} from "./types";

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
 * Run OCR on a single image, retrying only on transient errors up to
 * `MAX_RETRIES` additional times (3 total attempts). Returns the detected text
 * on success, or throws the last error once retries are exhausted / the error
 * is permanent.
 */
async function ocrImage(
  image: ArchiveImage,
  textract: TextractClient
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await textract.send(
        new DetectDocumentTextCommand({ Document: { Bytes: image.bytes } })
      );
      return linesFromResponse(response);
    } catch (err) {
      lastError = err;
      // Only keep retrying while the error is transient and attempts remain.
      if (!isTransientError(err) || attempt === MAX_RETRIES) {
        break;
      }
    }
  }

  throw lastError;
}

/**
 * Extract text from every supported image in an archive.
 *
 * Excluded entries are carried through untouched and are never sent to the OCR
 * service (4.5). Each supported image is OCR'd exactly once with limited retry
 * (4.1); an image that still fails is recorded in `imageFailures` and does not
 * abort the run (4.3).
 */
export async function extractFromArchive(
  images: ArchiveImage[],
  excluded: ExcludedEntry[],
  textract: TextractClient
): Promise<Result<ExtractionResult, StageError>> {
  const imageFailures: ImageFailure[] = [];
  const texts: string[] = [];

  // Process images in ascending order of entry name so the aggregated
  // Extracted_Text is concatenated in that same order (4.2).
  const ordered = [...images].sort((a, b) => a.name.localeCompare(b.name));

  for (const image of ordered) {
    try {
      const text = await ocrImage(image, textract);
      texts.push(text);
    } catch {
      imageFailures.push({
        name: image.name,
        reason: "OCR failed after retries",
      });
    }
  }

  // Aggregate the per-image text in entry-name order, separated by a newline
  // (4.2).
  const text = texts.join("\n");

  // If no image yielded any non-whitespace text, the extraction stage fails
  // with a "no text was extracted" error (4.4).
  if (text.trim().length === 0) {
    return {
      ok: false,
      error: { stage: STAGE, message: "no text was extracted" },
    };
  }

  // On success the ExtractionResult carries the per-image OCR failures and the
  // excluded entries so the reporter can surface them alongside the summary
  // (4.3, 6.2).
  return {
    ok: true,
    value: { text, imageFailures, excluded },
  };
}
