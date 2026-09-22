/**
 * AWS Lambda handler — the deployed entry point for the Text Summary Extractor.
 *
 * This mirrors the behavior of the local `src/server.ts` HTTP server, adapted
 * to the Lambda Function URL event/response shape (which uses the API Gateway
 * v2 / "payload format version 2.0" structure). It:
 *
 *   - serves the static frontend on `GET /` and `GET /index.html` (6.1)
 *   - accepts a single-file upload on `POST /api/summarize`, runs the pipeline
 *     over the uploaded bytes, and responds with JSON — `{ summary }` on
 *     success or `{ error, stage }` on failure (6.2, 6.3, 6.4)
 *
 * esbuild bundles this file to `index.js`, so the configured Lambda handler is
 * `index.handler`. The pipeline modules under `../../src` are pulled into the
 * bundle; `@aws-sdk/*` is left external because it is present in the runtime.
 */

import fs from "node:fs";
import path from "node:path";

import busboy from "busboy";
import { TextractClient } from "@aws-sdk/client-textract";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import { resolveConfig, type Config } from "../../src/config";
import { runPipeline } from "../../src/pipeline";
import { BedrockSummarizer, type Summarizer } from "../../src/summarizer";
import type { Stage, UploadedFile } from "../../src/types";

/**
 * Minimal Lambda Function URL event shape (payload format version 2.0). Only
 * the fields this handler needs are declared.
 */
interface FunctionUrlEvent {
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

/** Lambda Function URL / API Gateway v2 response shape. */
interface FunctionUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

// Construct expensive clients once per container, outside the handler, so they
// are reused across warm invocations.
const config: Config = resolveConfig();
const textract = new TextractClient({ region: config.awsRegion });
const bedrock = new BedrockRuntimeClient({ region: config.awsRegion });
const summarizer: Summarizer = new BedrockSummarizer(
  bedrock,
  config.bedrockModelId
);

/**
 * Map a failed pipeline stage to an HTTP status code (6.4), matching the local
 * server:
 *   - input-handling → 400
 *   - text-extraction → 422
 *   - summarization → 500
 */
function statusForStage(stage: Stage): number {
  switch (stage) {
    case "input-handling":
      return 400;
    case "text-extraction":
      return 422;
    case "summarization":
      return 500;
    default:
      return 400;
  }
}

/** Build a JSON Function URL response. */
function jsonResponse(status: number, body: unknown): FunctionUrlResponse {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Resolve the path to the bundled `index.html`.
 *
 * The frontend asset is packaged into the Lambda bundle directory alongside the
 * compiled `index.js`, so it sits next to `__dirname`. A working-directory
 * fallback keeps this robust across layouts.
 */
function resolveIndexHtmlPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "public", "index.html"),
    path.join(process.cwd(), "public", "index.html"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** Serve the static frontend page on `GET /` (6.1). */
function serveIndex(): FunctionUrlResponse {
  const indexPath = resolveIndexHtmlPath();
  if (indexPath === undefined) {
    return jsonResponse(500, {
      error: "Frontend asset index.html was not found.",
      stage: "input-handling",
    });
  }

  const html = fs.readFileSync(indexPath, "utf8");
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
}

/**
 * Parse the first uploaded file from a `multipart/form-data` request body.
 *
 * Unlike the streaming server, a Lambda event carries the whole body as a
 * (possibly base64-encoded) string, so busboy is fed the decoded buffer in one
 * shot. Resolves to the `UploadedFile { filename, bytes }` for the first file
 * field, or `undefined` when the request carries no file.
 */
function parseUpload(event: FunctionUrlEvent): Promise<UploadedFile | undefined> {
  return new Promise((resolve, reject) => {
    const contentType =
      event.headers?.["content-type"] ?? event.headers?.["Content-Type"];

    if (contentType === undefined) {
      resolve(undefined);
      return;
    }

    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: { "content-type": contentType } });
    } catch (err) {
      reject(err);
      return;
    }

    let uploaded: UploadedFile | undefined;
    let captured = false;

    bb.on("file", (_name, stream, info) => {
      if (captured) {
        stream.resume();
        return;
      }
      captured = true;

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const bytes = new Uint8Array(Buffer.concat(chunks));
        uploaded = { filename: info.filename, bytes };
      });
    });

    bb.on("close", () => resolve(uploaded));
    bb.on("error", (err) => reject(err));

    const raw = event.body ?? "";
    const buffer = event.isBase64Encoded
      ? Buffer.from(raw, "base64")
      : Buffer.from(raw, "utf8");
    bb.end(buffer);
  });
}

/**
 * Handle `POST /api/summarize`: parse the upload, run the pipeline, and respond
 * with JSON (6.2, 6.3, 6.4).
 */
async function handleSummarize(
  event: FunctionUrlEvent
): Promise<FunctionUrlResponse> {
  let file: UploadedFile | undefined;
  try {
    file = await parseUpload(event);
  } catch {
    return jsonResponse(400, {
      error: "The upload could not be parsed as multipart/form-data.",
      stage: "input-handling",
    });
  }

  // If no file is present, pass `undefined` so the pipeline's input handler
  // owns the "a file is required" message (1.3).
  const result = await runPipeline(file, config, textract, summarizer);

  if (result.ok) {
    return jsonResponse(200, { summary: result.summary });
  }

  return jsonResponse(statusForStage(result.error.stage), {
    error: result.error.message,
    stage: result.error.stage,
  });
}

/**
 * Lambda Function URL entry point. Routes GET `/` to the frontend and
 * POST `/api/summarize` to the pipeline; anything else is a 404.
 */
export async function handler(
  event: FunctionUrlEvent
): Promise<FunctionUrlResponse> {
  const method = event.requestContext?.http?.method ?? "GET";
  const rawPath =
    event.requestContext?.http?.path ?? event.rawPath ?? "/";
  const pathname = rawPath.split("?")[0];

  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return serveIndex();
  }

  if (method === "POST" && pathname === "/api/summarize") {
    try {
      return await handleSummarize(event);
    } catch {
      return jsonResponse(500, {
        error: "An unexpected error occurred.",
        stage: "summarization",
      });
    }
  }

  return jsonResponse(404, { error: "Not found.", stage: "input-handling" });
}
