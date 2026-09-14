/**
 * Summarization stage.
 *
 * Sends the extracted text to Amazon Bedrock and returns a concise summary.
 * The stage guards against empty input, truncates oversized input to a
 * configurable byte ceiling, and races the Bedrock call against a configurable
 * timeout so a slow or failing service never blocks the run indefinitely.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

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
 * Build the Anthropic Claude messages-format request body for a summarization
 * prompt over the given text.
 */
function buildRequestBody(text: string): string {
  return JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Summarize the following text concisely:\n\n${text}`,
      },
    ],
  });
}

/**
 * Invoke Bedrock and return the summary text, racing the call against the
 * configured timeout.
 */
async function invokeBedrock(
  text: string,
  config: Config,
  bedrock: BedrockRuntimeClient
): Promise<string> {
  const command = new InvokeModelCommand({
    modelId: config.bedrockModelId,
    contentType: "application/json",
    accept: "application/json",
    body: buildRequestBody(text),
  });

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("summarizer timed out")),
      config.summarizerTimeoutMs
    );
  });

  const response = await Promise.race([bedrock.send(command), timeout]);

  const payload = JSON.parse(new TextDecoder().decode(response.body));
  return payload.content[0].text;
}

/**
 * Summarize the extracted text.
 *
 * - If `text` is empty or whitespace-only, return a "no text to summarize"
 *   error without calling Bedrock (5.2).
 * - If the UTF-8 byte length exceeds `Max_Summarizer_Input`, truncate to that
 *   byte length before invoking Bedrock (5.5).
 * - Invoke Bedrock with a summarization prompt raced against the configured
 *   timeout; on error or timeout return a "summarization failed" error (5.4);
 *   on success return the summary text (5.1, 5.3).
 */
export async function summarize(
  text: string,
  config: Config,
  bedrock: BedrockRuntimeClient
): Promise<Result<string, StageError>> {
  // Guard: never spend a Bedrock call on empty input (5.2).
  if (text.trim().length === 0) {
    return summarizationError("There is no text to summarize.");
  }

  // Truncate oversized input to the configured byte ceiling before the call
  // so summarization cost stays bounded (5.5).
  const input = truncateToBytes(text, config.maxSummarizerInputBytes);

  try {
    const summary = await invokeBedrock(input, config, bedrock);
    return { ok: true, value: summary };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return summarizationError(`Summarization failed: ${reason}.`);
  }
}
