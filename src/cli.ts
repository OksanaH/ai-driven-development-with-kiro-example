#!/usr/bin/env node
/**
 * CLI entry point for the Text Summary Extractor.
 *
 * Parses the input path argument, resolves configuration, constructs the
 * Textract and Bedrock clients, runs the pipeline, and hands the result to the
 * reporter. Exits with a status that reflects the reported outcome: 0 on
 * success (6.1), non-zero on failure (6.3).
 */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { TextractClient } from "@aws-sdk/client-textract";

import { resolveConfig } from "./config";
import { runPipeline } from "./pipeline";
import { report } from "./reporter";

async function main(): Promise<number> {
  // Input path is the first positional argument (1.1).
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: text-summary-extractor <input.txt|input.zip>");
    return 1;
  }

  const config = resolveConfig();
  const textract = new TextractClient({ region: config.awsRegion });
  const bedrock = new BedrockRuntimeClient({ region: config.awsRegion });

  const result = await runPipeline(inputPath, config, textract, bedrock);
  report(result);

  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
