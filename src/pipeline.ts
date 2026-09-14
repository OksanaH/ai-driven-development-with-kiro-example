/**
 * Pipeline orchestration.
 *
 * Threads a single uploaded file through the three stages — input handling,
 * text extraction, and summarization — short-circuiting on the first
 * StageError so the endpoint can always name exactly one failed stage.
 *
 * The two extraction branches (text document vs. image) converge on a single
 * Extracted_Text string, which the summarizer consumes (4.2).
 */

import { TextractClient } from "@aws-sdk/client-textract";

import type { Config } from "./config";
import type { ProcessingResult, UploadedFile } from "./types";

import { classifyAndValidate } from "./inputHandler";
import { extractFromImage } from "./ocrExtractor";
import { runSummarizer, Summarizer } from "./summarizer";
import { readTextBytes } from "./textReader";

/**
 * Run the full pipeline for a single uploaded file.
 *
 * Flow:
 * 1. classifyAndValidate — reject unsupported / missing / oversized input
 *    (synchronous).
 * 2. Branch on classification: text → readTextBytes; image → extractFromImage.
 *    Both converge on a single Extracted_Text (1.1, 4.2).
 * 3. runSummarizer over the Extracted_Text.
 *
 * On the first StageError the pipeline stops and returns that error.
 */
export async function runPipeline(
  file: UploadedFile | undefined,
  config: Config,
  textract: TextractClient,
  summarizer: Summarizer
): Promise<ProcessingResult> {
  // Stage 1: input handling (synchronous).
  const classified = classifyAndValidate(file, config);
  if (!classified.ok) {
    return { ok: false, error: classified.error };
  }

  // Stage 2: text extraction. Both branches converge on a single
  // Extracted_Text string.
  let extractedText: string;

  if (classified.value.kind === "text") {
    const read = readTextBytes(classified.value.bytes);
    if (!read.ok) {
      return { ok: false, error: read.error };
    }
    extractedText = read.value;
  } else {
    const extracted = await extractFromImage(classified.value.bytes, textract);
    if (!extracted.ok) {
      return { ok: false, error: extracted.error };
    }
    extractedText = extracted.value;
  }

  // Stage 3: summarization.
  const summarized = await runSummarizer(extractedText, summarizer, config);
  if (!summarized.ok) {
    return { ok: false, error: summarized.error };
  }

  return { ok: true, summary: summarized.value };
}
