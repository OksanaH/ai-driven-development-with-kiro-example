/**
 * Shared types for the Text Summary Extractor pipeline.
 *
 * The pipeline threads small result values through each stage rather than
 * throwing across boundaries, so the endpoint can always name exactly one
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

/** A single file uploaded through the frontend, held in memory. */
export interface UploadedFile {
  /** Original upload name; used only to read the extension. */
  filename: string;
  /** Raw file contents held in memory. */
  bytes: Uint8Array;
}

/**
 * Outcome of classifying and validating the uploaded file. Carries the bytes
 * forward so no filesystem re-read is needed.
 */
export type InputClassification =
  | { kind: "text"; bytes: Uint8Array }
  | { kind: "image"; bytes: Uint8Array };

/** Final result threaded out of the pipeline. */
export type ProcessingResult =
  | { ok: true; summary: AsyncIterable<string> }
  | { ok: false; error: StageError };
