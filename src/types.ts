/**
 * Shared types for the Text Summary Extractor pipeline.
 *
 * The pipeline threads small result values through each stage rather than
 * throwing across boundaries, so the reporter can always name exactly one
 * failed stage.
 */

/** The three processing stages of the pipeline. */
export type Stage = "input-handling" | "text-extraction" | "summarization";

/** A stage-tagged failure carried through the pipeline. */
export interface StageError {
  stage: Stage;
  message: string;
}

/** Generic success/failure result used across stages. */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Outcome of classifying and validating the input file. */
export type InputClassification =
  | { kind: "text"; path: string }
  | {
      kind: "archive";
      path: string;
      images: ArchiveImage[];
      excluded: ExcludedEntry[];
    };

/** A supported image extracted from an archive. */
export interface ArchiveImage {
  /** Entry name within the zip. */
  name: string;
  /** Uncompressed image bytes. */
  bytes: Uint8Array;
}

/** An archive entry excluded from OCR because its type is unsupported. */
export interface ExcludedEntry {
  name: string;
  reason: "unsupported-type";
}

/** A per-image OCR failure recorded after retries are exhausted. */
export interface ImageFailure {
  name: string;
  /** e.g. "OCR failed after retries" */
  reason: string;
}

/** Result of the text-extraction stage. */
export interface ExtractionResult {
  text: string;
  /** OCR failures (archive only). */
  imageFailures: ImageFailure[];
  /** Excluded entries carried from input handling. */
  excluded: ExcludedEntry[];
}

/** Final result threaded out of the pipeline. */
export type ProcessingResult =
  | {
      ok: true;
      summary: string;
      /** Names of excluded + OCR-failed images. */
      affectedImages: string[];
    }
  | { ok: false; error: StageError };
