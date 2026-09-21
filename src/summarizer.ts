/**
 * Summarization stage.
 *
 * The `Summarizer` is defined as an interface so the mock implementation used
 * by this POC can be swapped for a real Amazon Bedrock implementation later
 * without changing any caller (5.3). `MockSummarizer` produces a deterministic
 * placeholder summary derived only from the input text, with no AWS call (5.4).
 *
 * `runSummarizer` wraps the interface with the cost-safety guards: it rejects
 * empty input without invoking the summarizer (5.2), truncates oversized input
 * to a configurable byte ceiling (5.6), and races the call against a
 * configurable timeout (5.5) so the contract stays identical to a future
 * networked implementation.
 */

import type { Config } from "./config";
import type { Result, StageError } from "./types";

const STAGE = "summarization" as const;

function summarizationError(message: string): Result<string, StageError> {
  return { ok: false, error: { stage: STAGE, message } };
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes.
 *
 * Uses a Buffer so the cut happens on a byte boundary. A trailing multi-byte
 * character split by the cut is dropped so the result stays valid UTF-8.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  return buffer.subarray(0, maxBytes).toString("utf8");
}

/**
 * The Summarizer contract. A single method turns text into a summary.
 *
 * Defined as an interface so the mock can be replaced by a real Bedrock
 * implementation without changing the callers (5.3).
 */
export interface Summarizer {
  summarize(text: string): Promise<string>;
}

/**
 * A local, deterministic Summarizer that never calls AWS (5.4).
 *
 * The placeholder is derived only from the input text: it reports the word
 * count followed by the full (whitespace-trimmed) text. The same input always
 * yields the same output.
 */
export class MockSummarizer implements Summarizer {
  async summarize(text: string): Promise<string> {
    const trimmed = text.trim();
    const wordCount = trimmed.split(/\s+/).filter((w) => w.length > 0).length;

    return `Summary (${wordCount} words): ${trimmed}`;
  }
}

/**
 * Summarize the extracted text using the given `Summarizer`.
 *
 * - If `text` is empty or whitespace-only, return a "no text to summarize"
 *   error without invoking the summarizer (5.2).
 * - If the UTF-8 byte length exceeds `Max_Summarizer_Input`, truncate to that
 *   byte length before invoking (5.6).
 * - Race the summarize call against the configured timeout; on error or
 *   timeout return a "summarization failed" error (5.5); on success return the
 *   summary (5.1).
 */
export async function runSummarizer(
  text: string,
  summarizer: Summarizer,
  config: Config
): Promise<Result<string, StageError>> {
  // Guard: never invoke the summarizer on empty input (5.2).
  if (text.trim().length === 0) {
    return summarizationError("There is no text to summarize.");
  }

  // Truncate oversized input to the configured byte ceiling before the call
  // so summarization cost stays bounded (5.6).
  const input = truncateToBytes(text, config.maxSummarizerInputBytes);

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("summarizer timed out")),
      config.summarizerTimeoutMs
    );
  });

  try {
    const summary = await Promise.race([summarizer.summarize(input), timeout]);
    return { ok: true, value: summary };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return summarizationError(`Summarization failed: ${reason}.`);
  }
}
