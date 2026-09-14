/**
 * Text-extraction stage for plain text documents.
 *
 * Reads a `.txt` document directly and decodes it as UTF-8 — no OCR is
 * involved (Requirement 3.1). Undecodable content and empty/whitespace-only
 * content each map to a stage-tagged error (Requirements 3.3, 3.2).
 */

import { readFileSync } from "node:fs";
import type { Result, StageError } from "./types.js";

const STAGE = "text-extraction" as const;

/** Read and decode a text document into Extracted_Text. */
export function readTextDocument(path: string): Result<string, StageError> {
  const bytes = readFileSync(path);

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
