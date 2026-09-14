/**
 * HTTP server — the primary entry point for the Text Summary Extractor.
 *
 * Built on Node's built-in `http` module (no web framework). It serves the
 * static frontend on `GET /` and accepts a single-file upload on
 * `POST /api/summarize`, runs the pipeline over the uploaded bytes, and
 * responds with JSON: `{ summary }` on success or `{ error, stage }` on
 * failure (6.1–6.4).
 *
 * Multipart parsing uses `busboy` to extract the first file's original
 * filename and raw bytes from a `multipart/form-data` body.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import busboy from "busboy";
import { TextractClient } from "@aws-sdk/client-textract";

import { resolveConfig, type Config } from "./config";
import { runPipeline } from "./pipeline";
import { MockSummarizer, type Summarizer } from "./summarizer";
import type { Stage, UploadedFile } from "./types";

/**
 * Map a failed pipeline stage to an HTTP status code (6.4).
 *
 * - input-handling → 400 (bad request)
 * - text-extraction → 422 (unprocessable entity)
 * - summarization → 500 (internal error)
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

/** Send a JSON response with the given status code. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Resolve the path to `public/index.html`.
 *
 * The compiled file lives in `dist/`, so the asset sits at
 * `../public/index.html` relative to `__dirname`. If it is not found there
 * (e.g. when run from a different layout), fall back to a path relative to the
 * current working directory.
 */
function resolveIndexHtmlPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "public", "index.html"),
    path.join(process.cwd(), "public", "index.html"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** Serve the static frontend page on `GET /` (6.1). */
function serveIndex(res: http.ServerResponse): void {
  const indexPath = resolveIndexHtmlPath();
  if (indexPath === undefined) {
    sendJson(res, 500, {
      error: "Frontend asset public/index.html was not found.",
      stage: "input-handling",
    });
    return;
  }

  const html = fs.readFileSync(indexPath);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": html.byteLength,
  });
  res.end(html);
}

/**
 * Parse the first uploaded file from a `multipart/form-data` request body.
 *
 * Resolves to the `UploadedFile { filename, bytes }` for the first file field
 * (named "file" by the frontend), or `undefined` if the request carries no
 * file. Rejects only on a malformed multipart body.
 */
function parseUpload(req: http.IncomingMessage): Promise<UploadedFile | undefined> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers });
    } catch (err) {
      reject(err);
      return;
    }

    let uploaded: UploadedFile | undefined;
    let captured = false;

    bb.on("file", (_name, stream, info) => {
      // Only capture the first file; drain any additional files.
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

    req.pipe(bb);
  });
}

/**
 * Handle `POST /api/summarize`: parse the upload, run the pipeline, and respond
 * with JSON (6.2, 6.3, 6.4).
 */
async function handleSummarize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
  textract: TextractClient,
  summarizer: Summarizer
): Promise<void> {
  let file: UploadedFile | undefined;
  try {
    file = await parseUpload(req);
  } catch {
    sendJson(res, 400, {
      error: "The upload could not be parsed as multipart/form-data.",
      stage: "input-handling",
    });
    return;
  }

  // If no file is present, pass `undefined` so the pipeline's input handler
  // owns the "a file is required" message (1.3).
  const result = await runPipeline(file, config, textract, summarizer);

  if (result.ok) {
    sendJson(res, 200, { summary: result.summary });
    return;
  }

  sendJson(res, statusForStage(result.error.stage), {
    error: result.error.message,
    stage: result.error.stage,
  });
}

/**
 * Build and start the HTTP server.
 *
 * Serves the frontend on `GET /` and `GET /index.html`, handles the upload on
 * `POST /api/summarize`, and returns 404 for anything else. The server is
 * returned (already listening) so callers can inspect or close it.
 */
export function startServer(
  config: Config,
  textract: TextractClient
): http.Server {
  const summarizer = new MockSummarizer();

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    // Strip any query string for routing.
    const pathname = url.split("?")[0];

    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      serveIndex(res);
      return;
    }

    if (method === "POST" && pathname === "/api/summarize") {
      handleSummarize(req, res, config, textract, summarizer).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: "An unexpected error occurred.",
            stage: "summarization",
          });
        }
      });
      return;
    }

    sendJson(res, 404, { error: "Not found.", stage: "input-handling" });
  });

  server.listen(config.httpPort, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${config.httpPort}`);
  });

  return server;
}

// Runnable entry point: resolve config, construct the Textract client and the
// mock summarizer, and start the server.
if (require.main === module) {
  const config = resolveConfig();
  const textract = new TextractClient({ region: config.awsRegion });
  startServer(config, textract);
}
