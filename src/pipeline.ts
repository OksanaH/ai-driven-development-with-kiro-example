/**
 * Pipeline orchestration.
 *
 * Threads a single input through the three stages — input handling, text
 * extraction, and summarization — short-circuiting on the first StageError so
 * the reporter can always name exactly one failed stage (6.3).
 *
 * The two extraction branches (text document vs. image archive) converge on a
 * single Extracted_Text string, which the summarizer consumes (4.2). For a
 * successful archive run, `affectedImages` is the union of excluded entry
 * names and OCR-failed image names (6.4).
 */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { TextractClient } from "@aws-sdk/client-textract";

import type { Config } from "./config";
import type { ProcessingResult } from "./types";

import { classifyAndValidate } from "./inputHandler";
import { extractFromArchive } from "./ocrExtractor";
import { summarize } from "./summarizer";
import { readTextDocument } from "./textReader";

/**
 * Run the full pipeline for a single input path.
 *
 * Flow:
 * 1. classifyAndValidate — reject unsupported / missing / oversized input.
 * 2. Branch on classification: text → readTextDocument; archive →
 *    extractFromArchive. Both converge on a single Extracted_Text.
 * 3. summarize the Extracted_Text.
 *
 * On the first StageError the pipeline stops and returns that error (6.3).
 */
export async function runPipeline(
  inputPath: string,
  config: Config,
  textract: TextractClient,
  bedrock: BedrockRuntimeClient
): Promise<ProcessingResult> {
  // Stage 1: input handling.
  const classified = await classifyAndValidate(inputPath, config);
  if (!classified.ok) {
    return { ok: false, error: classified.error };
  }

  // Stage 2: text extraction. Both branches produce the Extracted_Text plus
  // the set of affected image names (empty for a text document).
  let extractedText: string;
  let affectedImages: string[];

  if (classified.value.kind === "text") {
    const read = readTextDocument(classified.value.path);
    if (!read.ok) {
      return { ok: false, error: read.error };
    }
    extractedText = read.value;
    affectedImages = [];
  } else {
    const { images, excluded } = classified.value;
    const extracted = await extractFromArchive(images, excluded, textract);
    if (!extracted.ok) {
      return { ok: false, error: extracted.error };
    }
    extractedText = extracted.value.text;
    // Union of excluded entry names and OCR-failed image names (6.4).
    affectedImages = [
      ...extracted.value.excluded.map((entry) => entry.name),
      ...extracted.value.imageFailures.map((failure) => failure.name),
    ];
  }

  // Stage 3: summarization.
  const summarized = await summarize(extractedText, config, bedrock);
  if (!summarized.ok) {
    return { ok: false, error: summarized.error };
  }

  return { ok: true, summary: summarized.value, affectedImages };
}
