/**
 * Input handling stage.
 *
 * Classifies the uploaded file by extension and validates that its bytes are
 * present and readable, then enforces the size limit. All rejections happen
 * here, before any AWS call, so that unsupported, missing, oversized, or
 * unreadable inputs never incur processing cost.
 *
 * This stage operates entirely on in-memory bytes: there is no filesystem
 * access and no archive handling. It is synchronous and returns a Result
 * directly.
 */

import type { Config } from "./config";
import type { InputClassification, Result, StageError, UploadedFile } from "./types";

const STAGE = "input-handling" as const;

function inputError(message: string): Result<InputClassification, StageError> {
  return { ok: false, error: { stage: STAGE, message } };
}

/**
 * Derive the lowercased file extension (including the leading dot) from a
 * filename, or an empty string when there is none.
 */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) {
    return "";
  }
  return filename.slice(dot).toLowerCase();
}

/**
 * Classify the uploaded file and validate it before any further processing.
 *
 * - Missing/undefined `file` → "a file is required" error (1.3).
 * - Extension from `file.filename` (case-insensitive): `.txt` → text;
 *   `.jpg`/`.jpeg` → image; anything else → descriptive error naming the
 *   detected extension (1.1, 1.2).
 * - Unreadable/empty upload buffer → "could not be accessed" error (1.4).
 * - Bytes strictly larger than `maxInputSizeBytes` → oversized error stating
 *   the configured limit, before any AWS call (2.2, 2.3).
 * - On success, return the classification carrying the bytes forward.
 */
export function classifyAndValidate(
  file: UploadedFile | undefined,
  config: Config
): Result<InputClassification, StageError> {
  // No file in the submission (1.3).
  if (file === undefined) {
    return inputError("A file is required.");
  }

  // Classify by extension first so an unsupported type is rejected with a
  // clear message (1.1, 1.2).
  const extension = extensionOf(file.filename);
  let kind: "text" | "image";
  if (extension === ".txt") {
    kind = "text";
  } else if (extension === ".jpg" || extension === ".jpeg") {
    kind = "image";
  } else {
    const detected = extension === "" ? "(none)" : extension;
    return inputError(
      `Unsupported input type: detected extension "${detected}". Only .txt, .jpg, and .jpeg are supported.`
    );
  }

  // The upload buffer must be present and non-empty to be readable (1.4).
  const bytes = file.bytes;
  if (bytes === undefined || bytes.byteLength === 0) {
    return inputError("The uploaded file could not be accessed.");
  }

  // Reject strictly-oversized uploads before any AWS call, stating the limit
  // (2.2, 2.3). A size equal to the limit is accepted; only greater is
  // rejected.
  if (bytes.byteLength > config.maxInputSizeBytes) {
    return inputError(
      `Input exceeds the size limit: ${bytes.byteLength} bytes is larger than the configured Max_Input_Size of ${config.maxInputSizeBytes} bytes.`
    );
  }

  return { ok: true, value: { kind, bytes } };
}
