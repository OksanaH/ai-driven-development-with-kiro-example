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

// Ambient declaration for the `awslambda` global injected by the Lambda Node 20
// runtime. Not available as an npm package — declared inline per Design §3 / Option A.
declare const awslambda: {
  streamifyResponse(
    handler: (
      event: FunctionUrlEvent,
      responseStream: NodeJS.WritableStream,
      context: unknown
    ) => Promise<void>
  ): unknown;
  HttpResponseStream: {
    from(
      responseStream: NodeJS.WritableStream,
      init: { statusCode: number; headers: Record<string, string> }
    ): NodeJS.WritableStream;
  };
};

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
function serveIndex(responseStream: NodeJS.WritableStream): void {
  const indexPath = resolveIndexHtmlPath();
  if (indexPath === undefined) {
    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
    });
    stream.write(
      JSON.stringify({
        error: "Frontend asset index.html was not found.",
        stage: "input-handling",
      })
    );
    stream.end();
    return;
  }

  const html = fs.readFileSync(indexPath, "utf8");
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  stream.write(html);
  stream.end();
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
 * Stream the summary to the client as Server-Sent Events (AC-1–AC-6).
 *
 * - Attaches SSE headers via `awslambda.HttpResponseStream.from` (AC-6).
 * - Starts a `timeoutMs` timer; if no chunk arrives in time, emits a timeout
 *   error event and closes the stream (AC-5).
 * - For each chunk from the `AsyncIterable`, clears the timer on the first
 *   chunk and emits a `delta` event (AC-2).
 * - On exhaustion, emits a `done` event and closes the stream (AC-3).
 * - On iterable error, emits an `error` event and closes the stream (AC-4).
 */
async function streamSummary(
  stream: NodeJS.WritableStream,
  summary: AsyncIterable<string>,
  timeoutMs: number
): Promise<void> {
  const sseStream = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    sseStream.write(
      `data: ${JSON.stringify({ type: "error", error: "Summarization timed out.", stage: "summarization" })}\n\n`
    );
    sseStream.end();
  }, timeoutMs);

  try {
    for await (const chunk of summary) {
      // If the timeout fired before the first chunk arrived, the stream is
      // already closed — stop iterating.
      if (timedOut) break;
      clearTimeout(timer);
      sseStream.write(`data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`);
    }

    if (!timedOut) {
      clearTimeout(timer);
      sseStream.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    }
  } catch (err) {
    clearTimeout(timer);
    if (!timedOut) {
      const message = err instanceof Error ? err.message : String(err);
      sseStream.write(
        `data: ${JSON.stringify({ type: "error", error: message, stage: "summarization" })}\n\n`
      );
    }
  } finally {
    sseStream.end();
  }
}

/**
 * Handle `POST /api/summarize`: parse the upload, run the pipeline, and stream
 * the summary as SSE — or write a JSON error body — directly to `stream`
 * (6.2, 6.3, 6.4, AC-1–AC-6).
 */
async function handleSummarize(
  event: FunctionUrlEvent,
  stream: NodeJS.WritableStream
): Promise<void> {
  let file: UploadedFile | undefined;
  try {
    file = await parseUpload(event);
  } catch {
    const errStream = awslambda.HttpResponseStream.from(stream, {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
    });
    errStream.write(
      JSON.stringify({
        error: "The upload could not be parsed as multipart/form-data.",
        stage: "input-handling",
      })
    );
    errStream.end();
    return;
  }

  // If no file is present, pass `undefined` so the pipeline's input handler
  // owns the "a file is required" message (1.3).
  const result = await runPipeline(file, config, textract, summarizer);

  if (result.ok) {
    await streamSummary(stream, result.summary, config.summarizerTimeoutMs);
    return;
  }

  const status = statusForStage(result.error.stage);
  const errStream = awslambda.HttpResponseStream.from(stream, {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
  });
  errStream.write(
    JSON.stringify({
      error: result.error.message,
      stage: result.error.stage,
    })
  );
  errStream.end();
}

/**
 * Inner router passed to `awslambda.streamifyResponse` (Design §4.2, AC-7, AC-8).
 *
 * Routes every request to the appropriate handler, writing directly to the
 * Lambda response stream rather than returning a response object:
 *
 * - `GET /` and `GET /index.html` → serve the frontend HTML via the stream.
 * - `POST /api/summarize` → delegate to `handleSummarize` for SSE streaming.
 * - Anything else → write a JSON 404 body and close the stream.
 *
 * Non-streaming paths (GET /, 404) write their full body in a single `write`
 * call and call `stream.end()` immediately, so the behaviour is
 * indistinguishable from a normal Lambda response.
 */
async function routeRequest(
  event: FunctionUrlEvent,
  responseStream: NodeJS.WritableStream,
  _context: unknown
): Promise<void> {
  const method = event.requestContext?.http?.method ?? "GET";
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? "/";
  const pathname = rawPath.split("?")[0];

  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    serveIndex(responseStream);
    return;
  }

  if (method === "POST" && pathname === "/api/summarize") {
    await handleSummarize(event, responseStream);
    return;
  }

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 404,
    headers: { "Content-Type": "application/json" },
  });
  stream.write(JSON.stringify({ error: "Not found.", stage: "input-handling" }));
  stream.end();
}

/**
 * Lambda Function URL entry point. Uses `awslambda.streamifyResponse` so that
 * Lambda streams each SSE chunk to the client as it is written, rather than
 * buffering the entire response (AC-8, Design §4.4).
 */
export const handler = awslambda.streamifyResponse(routeRequest);
