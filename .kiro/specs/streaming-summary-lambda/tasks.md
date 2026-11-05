# Implementation Tasks: Lambda Streaming Summary Bug Fix

## Overview

Fix `terraform/lambda/handler.ts` so `POST /api/summarize` streams SSE chunks to the browser progressively via `awslambda.streamifyResponse`, instead of buffering all Bedrock output and returning a single JSON blob.

Only `terraform/lambda/handler.ts` changes. All `src/` files, Terraform config, the build script, and `public/index.html` are untouched.

---

## Tasks

- [x] 1. Add the `awslambda` ambient TypeScript declaration

  At the top of `handler.ts`, add a `declare const awslambda` block that types `streamifyResponse` and `HttpResponseStream.from`. This lets TypeScript accept the Lambda runtime global without an npm package or extra `.d.ts` file, matching Design §3 / Option A.

- [x] 2. Add the `streamSummary` helper function

  Implement `async function streamSummary(stream: NodeJS.WritableStream, summary: AsyncIterable<string>, timeoutMs: number): Promise<void>` that:
  - Calls `awslambda.HttpResponseStream.from` to attach SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`, status 200).
  - Starts a `setTimeout` for `timeoutMs`; on expiry writes the timeout error SSE event and calls `stream.end()` (AC-5).
  - For each chunk: clears the timer on the first arrival, writes a `delta` SSE event (AC-2).
  - After the iterable exhausts: writes a `done` SSE event and calls `stream.end()` (AC-3).
  - On iterable error: writes an `error` SSE event and calls `stream.end()` (AC-4).

  Mirror the logic in `src/server.ts → streamSummary` exactly.

- [x] 3. Refactor `handleSummarize` to write to a stream

  Change the signature from `handleSummarize(event): Promise<FunctionUrlResponse>` to `handleSummarize(event: FunctionUrlEvent, stream: NodeJS.WritableStream): Promise<void>`.
  - Remove the `for await … chunks.push(chunk)` buffering loop and the `jsonResponse(200, { summary })` return (this is the core bug fix).
  - On a successful pipeline result, call `await streamSummary(stream, result.summary, config.summarizerTimeoutMs)` instead.
  - On pipeline error (not-ok result), attach JSON headers via `awslambda.HttpResponseStream.from` and write the error body directly, then call `stream.end()`.
  - On parse error, do the same for the 400 case.

- [x] 4. Add the `routeRequest` inner function

  Implement `async function routeRequest(event: FunctionUrlEvent, responseStream: NodeJS.WritableStream, context: unknown): Promise<void>` that reproduces the routing logic currently in `handler`:
  - `GET /` and `GET /index.html` → attach HTML headers via `HttpResponseStream.from`, write the HTML body, call `stream.end()`.
  - `POST /api/summarize` → call `await handleSummarize(event, responseStream)`.
  - Anything else → attach JSON headers, write `{ error: "Not found.", stage: "input-handling" }`, call `stream.end()`.

  Non-streaming paths write the full body in a single `write` call and end immediately, so their behaviour is indistinguishable from a normal response (AC-7, Design §4.2).

- [x] 5. Replace the exported `handler` with `awslambda.streamifyResponse(routeRequest)`

  Remove the current `export async function handler(event): Promise<FunctionUrlResponse>` and replace it with:

  ```ts
  export const handler = awslambda.streamifyResponse(routeRequest);
  ```

  This is the only exported name; esbuild CJS output sets `exports.handler` from it, which Lambda resolves as `index.handler` (AC-8, Design §4.4).

- [x] 6. Remove or inline the now-unused `FunctionUrlResponse` interface and `jsonResponse` helper

  `jsonResponse` returned a `FunctionUrlResponse` object — a shape that no longer exists in the streaming handler. Remove both. Any remaining call sites (error paths in `routeRequest` and `handleSummarize`) should write directly to the stream via `HttpResponseStream.from` + `stream.write` + `stream.end()`.

- [x] 7. Build and verify the TypeScript compiles cleanly

  Run the existing esbuild bundle command from `terraform/lambda/`:

  ```
  npx esbuild handler.ts --bundle --platform=node --target=node20 --format=cjs --sourcemap --external:@aws-sdk/* --outfile=../.build/index.js
  ```

  Confirm it exits 0 with no errors. The `awslambda` global produces no bundle output (it is erased by the TypeScript compilation step inside esbuild). No changes to `build.tf` or `terraform/lambda/package.json` are needed (AC-10).
