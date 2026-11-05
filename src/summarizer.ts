/**
 * Summarization stage.
 *
 * The `Summarizer` is defined as an interface so the mock implementation used
 * by this POC can be swapped for a real Amazon Bedrock implementation later
 * without changing any caller (5.3). `MockSummarizer` produces a deterministic
 * placeholder summary derived only from the input text, with no AWS call (5.4).
 *
 * `BedrockSummarizer` is the real implementation: it calls Amazon Bedrock's
 * streaming API and yields text deltas as they are generated. `MockSummarizer`
 * is kept for offline/local runs and tests.
 */

import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

/**
 * The Summarizer contract. A single method turns text into a summary stream.
 *
 * Defined as an interface so the mock can be replaced by a real Bedrock
 * implementation without changing the callers (5.3).
 */
export interface Summarizer {
  summarize(text: string): AsyncIterable<string>;
}

/**
 * A local, deterministic Summarizer that never calls AWS (5.4).
 *
 * The placeholder is derived only from the input text: it reports the word
 * count followed by the full (whitespace-trimmed) text. The same input always
 * yields the same output.
 */
export class MockSummarizer implements Summarizer {
  async *summarize(text: string): AsyncIterable<string> {
    const trimmed = text.trim();
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    // Yield the header first (R1.3)
    yield `Summary (${words.length} words): `;
    // Then yield each word with a 40 ms delay between words (R1.3)
    for (const word of words) {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      yield word + " ";
    }
  }
}

/** Anthropic Messages API version identifier expected by Bedrock. */
const ANTHROPIC_VERSION = "bedrock-2023-05-31";

/** Upper bound on the summary length the model is allowed to generate. */
const MAX_OUTPUT_TOKENS = 1024;

/** Instruction that steers the model toward a concise, faithful summary. */
const SYSTEM_PROMPT =
  "You are a summarization assistant. Produce a concise, accurate summary of " +
  "the user's text. Capture the main points and key details, use plain prose, " +
  "and do not add information that is not present in the text.";

/** Shape of a single streaming event emitted by the Anthropic Messages API on Bedrock. */
interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
}

/**
 * A real Summarizer backed by Amazon Bedrock (R1.2, R1.4).
 *
 * Uses `InvokeModelWithResponseStreamCommand` to receive text deltas as they
 * are generated. Each streaming event is decoded and parsed; events with
 * `type: "content_block_delta"` and `delta.type: "text_delta"` carry a text
 * chunk that is yielded immediately.
 *
 * Any error thrown during iteration — whether from the SDK or from the model
 * — propagates naturally to the caller (R1.4).
 */
export class BedrockSummarizer implements Summarizer {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string
  ) {}

  async *summarize(text: string): AsyncIterable<string> {
    const body = JSON.stringify({
      anthropic_version: ANTHROPIC_VERSION,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `Summarize the following text:\n\n${text}` }],
        },
      ],
    });

    const response = await this.client.send(
      new InvokeModelWithResponseStreamCommand({
        modelId: this.modelId,
        contentType: "application/json",
        accept: "application/json",
        body,
      })
    );

    for await (const event of response.body ?? []) {
      if (!event.chunk?.bytes) continue;
      const decoded = new TextDecoder().decode(event.chunk.bytes);
      const parsed = JSON.parse(decoded) as AnthropicStreamEvent;
      if (
        parsed.type === "content_block_delta" &&
        parsed.delta?.type === "text_delta" &&
        typeof parsed.delta.text === "string"
      ) {
        yield parsed.delta.text;
      }
    }
  }
}

