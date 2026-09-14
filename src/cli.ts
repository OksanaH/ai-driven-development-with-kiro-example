#!/usr/bin/env node
/**
 * Optional CLI entry point for the Text Summary Extractor.
 *
 * The primary entry point is the HTTP server (server.ts); this CLI is a
 * secondary convenience for one-off local runs. It reads a file path from the
 * command line, loads the bytes from disk into an UploadedFile, resolves
 * configuration, constructs a Textract client and the MockSummarizer, runs the
 * pipeline, and hands the result to the reporter. Exits 0 on success, 1 on
 * failure.
 */

import fs from "node:fs";
import path from "node:path";

import { TextractClient } from "@aws-sdk/client-textract";

import { resolveConfig } from "./config";
import { runPipeline } from "./pipeline";
import { report } from "./reporter";
import { MockSummarizer } from "./summarizer";
import type { UploadedFile } from "./types";

async function main(): Promise<number> {
  // Input path is the first positional argument.
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: text-summary-extractor <input.txt|input.jpg|input.jpeg>");
    return 1;
  }

  // Read the file from disk into memory. A missing/unreadable file is handled
  // gracefully with a clear message and a non-zero exit.
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(inputPath);
  } catch {
    console.error(`Could not read file: ${inputPath}`);
    return 1;
  }

  const file: UploadedFile = {
    filename: path.basename(inputPath),
    bytes: new Uint8Array(buffer),
  };

  const config = resolveConfig();
  const textract = new TextractClient({ region: config.awsRegion });
  const summarizer = new MockSummarizer();

  const result = await runPipeline(file, config, textract, summarizer);
  report(result);

  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
