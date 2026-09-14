/**
 * Text-extraction stage for plain text documents.
 *
 * Decodes the uploaded file's in-memory bytes as UTF-8 — no OCR and no
 * filesystem access are involved (Requirement 3.1). Undecodable content and
 * empty/whitespace-only content each map to a stage-tagged error
 * (Requirements 3.3, 3.2).
 */

import type { Result, StageError } from "./types";

const STAGE = "text-extraction" as const;

/** Decode uploaded text bytes into Extracted_Text. */
export function readTextBytes(bytes: Uint8Array): Result<string, StageError> {
  let content: string;
  try {
    // fatal: true so invalid UTF-8 throws instead of being silently replaced.
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      error: { stage: STAGE, message: "The document could not be decoded as text." },
    };
  }

  if (content.trim().length === 0) {
    return {
      ok: false,
      error: { stage: STAGE, message: "The document is empty." },
    };
  }

  return { ok: true, value: content };
}
