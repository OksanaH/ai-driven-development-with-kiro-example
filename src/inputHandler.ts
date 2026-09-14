/**
 * Input handling stage.
 *
 * Classifies the input file by extension and validates that its path exists
 * and is readable. All rejections happen here, before any AWS call, so that
 * unsupported, missing, or unreadable inputs never incur processing cost.
 *
 * This module establishes the structure for input handling. Archive
 * enumeration (task 3.3) builds on top of the branches laid out here; the
 * text-document size limit is enforced here (task 3.2).
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";

import AdmZip from "adm-zip";

import type { Config } from "./config";
import type {
  ArchiveImage,
  ExcludedEntry,
  InputClassification,
  Result,
  StageError,
} from "./types";

/** File extensions that count as supported images inside an archive. */
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

const STAGE = "input-handling" as const;

function inputError(message: string): Result<InputClassification, StageError> {
  return { ok: false, error: { stage: STAGE, message } };
}

/**
 * Classify the input and validate that it exists and can be read.
 *
 * - `.txt` (case-insensitive) → text document.
 * - `.zip` (case-insensitive) → image archive.
 * - anything else → descriptive error naming the detected extension.
 * - missing path → "not found" error.
 * - existing but unreadable path → "could not be accessed" error.
 */
export async function classifyAndValidate(
  inputPath: string,
  config: Config
): Promise<Result<InputClassification, StageError>> {
  const extension = path.extname(inputPath).toLowerCase();

  // Classify by extension first so an unsupported type is rejected with a
  // clear message regardless of whether the file happens to exist.
  if (extension !== ".txt" && extension !== ".zip") {
    const detected = extension === "" ? "(none)" : extension;
    return inputError(
      `Unsupported input type: detected extension "${detected}". Only .txt and .zip are supported.`
    );
  }

  // Existence + readability check before any further processing.
  try {
    await fs.access(inputPath, fsConstants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return inputError(`Input not found: "${inputPath}".`);
    }
    return inputError(`Input could not be accessed: "${inputPath}".`);
  }

  if (extension === ".txt") {
    // Reject oversized documents before any AWS call so that summarization
    // cost stays bounded (2.2). The check is strict: a size equal to the limit
    // is accepted, only a size greater than the limit is rejected.
    const { size } = await fs.stat(inputPath);
    if (size > config.maxInputSizeBytes) {
      return inputError(
        `Input exceeds the size limit: ${size} bytes is larger than the configured Max_Input_Size of ${config.maxInputSizeBytes} bytes.`
      );
    }
    return { ok: true, value: { kind: "text", path: inputPath } };
  }

  // extension === ".zip"
  // Enumerate the archive entries, classify each by extension, and enforce the
  // size limit — all before any OCR call so unsupported/oversized archives
  // never incur processing cost.
  const zip = new AdmZip(inputPath);

  const images: ArchiveImage[] = [];
  const excluded: ExcludedEntry[] = [];
  let totalUncompressedBytes = 0;

  for (const entry of zip.getEntries()) {
    // Directory entries are not files to OCR; skip them entirely.
    if (entry.isDirectory) {
      continue;
    }

    totalUncompressedBytes += entry.header.size;

    const entryExtension = path.extname(entry.entryName).toLowerCase();
    if (SUPPORTED_IMAGE_EXTENSIONS.has(entryExtension)) {
      images.push({ name: entry.entryName, bytes: entry.getData() });
    } else {
      // Unsupported type: record for reporting, never send to the OCR service.
      excluded.push({ name: entry.entryName, reason: "unsupported-type" });
    }
  }

  // No supported images means there is nothing to OCR (1.6).
  if (images.length === 0) {
    return inputError(
      "Archive contains no supported images: expected at least one .png, .jpg, or .jpeg entry."
    );
  }

  // Reject strictly-oversized archives before any AWS call, stating the limit
  // (2.3). A total equal to the limit is accepted; only greater is rejected.
  if (totalUncompressedBytes > config.maxInputSizeBytes) {
    return inputError(
      `Input exceeds the size limit: total uncompressed archive size ${totalUncompressedBytes} bytes is larger than the configured Max_Input_Size of ${config.maxInputSizeBytes} bytes.`
    );
  }

  return {
    ok: true,
    value: { kind: "archive", path: inputPath, images, excluded },
  };
}
