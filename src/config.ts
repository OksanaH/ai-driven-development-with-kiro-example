/**
 * Configuration resolution for the Text Summary Extractor.
 *
 * Values are resolved from environment variables with POC defaults. No config
 * file is needed for the proof of concept.
 */

/** Resolved application configuration. */
export interface Config {
  /** Upper bound on input size in bytes. Default 10 MB, valid 1..100 MB. */
  maxInputSizeBytes: number;
  /** Truncation ceiling, in bytes, for the summarizer input. */
  maxSummarizerInputBytes: number;
  /** Bedrock invocation timeout in milliseconds. */
  summarizerTimeoutMs: number;
  /** Foundation model used for summarization. */
  bedrockModelId: string;
  /** AWS region for the Textract and Bedrock clients. */
  awsRegion: string;
  /** HTTP port the local Web_Server listens on. Default 3000. */
  httpPort: number;
}

/** Default Max_Input_Size: 10 MB. */
const DEFAULT_MAX_INPUT_SIZE_BYTES = 10_485_760;
/** Inclusive lower bound for Max_Input_Size: 1 byte. */
const MIN_INPUT_SIZE_BYTES = 1;
/** Inclusive upper bound for Max_Input_Size: 100 MB. */
const MAX_INPUT_SIZE_BYTES = 104_857_600;

/** POC defaults for the remaining configurable values. */
const DEFAULT_MAX_SUMMARIZER_INPUT_BYTES = 100_000;
const DEFAULT_SUMMARIZER_TIMEOUT_MS = 30_000;
const DEFAULT_BEDROCK_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0";
const DEFAULT_AWS_REGION = "us-east-1";
const DEFAULT_HTTP_PORT = 3000;

/**
 * Resolve the Max_Input_Size from an environment value, clamping to the
 * inclusive range 1..104,857,600 and falling back to the default when the
 * value is missing, non-numeric, or out of range (2.1).
 */
function resolveMaxInputSize(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_MAX_INPUT_SIZE_BYTES;
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < MIN_INPUT_SIZE_BYTES ||
    value > MAX_INPUT_SIZE_BYTES
  ) {
    return DEFAULT_MAX_INPUT_SIZE_BYTES;
  }
  return value;
}

/**
 * Resolve configuration from environment variables with POC defaults.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    maxInputSizeBytes: resolveMaxInputSize(env.MAX_INPUT_SIZE_BYTES),
    maxSummarizerInputBytes:
      Number(env.MAX_SUMMARIZER_INPUT_BYTES) ||
      DEFAULT_MAX_SUMMARIZER_INPUT_BYTES,
    summarizerTimeoutMs:
      Number(env.SUMMARIZER_TIMEOUT_MS) || DEFAULT_SUMMARIZER_TIMEOUT_MS,
    bedrockModelId: env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL_ID,
    awsRegion: env.AWS_REGION || DEFAULT_AWS_REGION,
    httpPort: Number(env.HTTP_PORT || env.PORT) || DEFAULT_HTTP_PORT,
  };
}
