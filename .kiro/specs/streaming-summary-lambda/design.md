# Design: Lambda Streaming Summary Bug Fix

## 1. Problem recap

`terraform/lambda/handler.ts` collects every chunk from `BedrockSummarizer.summarize` into an array and returns a single `{ summary: "…" }` JSON body. The Lambda Function URL sends nothing to the browser until Bedrock finishes. The fix converts the `POST /api/summarize` path to use the Lambda streaming API and the Server-Sent Events (SSE) wire format already consumed by `public/index.html`.

---

## 2. How `awslambda.streamifyResponse` works

Lambda's Node 20 runtime injects an `awslambda` global (not an npm package) that exposes a single helper:

```ts
awslambda.streamifyResponse(
  (event, responseStream, context) => Promise<void>
)
```

Calling it returns a value that Lambda recognises as a streaming handler export. Instead of returning a response object, the inner function:

1. Calls `awslambda.HttpResponseStream.from(responseStream, metadata)` to attach HTTP metadata (status code, headers) to the stream. This must be done before any `write` call.
2. Writes chunks to the resulting writable stream with `stream.write(chunk)`.
3. Calls `stream.end()` when done (or on error). Lambda flushes each write to the client immediately.

`HttpResponseStream.from` signature:

```ts
awslambda.HttpResponseStream.from(
  writable: Writable,
  metadata: { statusCode: number; headers: Record<string, string> }
): Writable
```

The returned writable is what you write SSE lines to. Lambda does not buffer — each `write` is sent to the client as soon as it is called.

For non-streaming paths (GET /, 404, 4xx errors returned before streaming starts) the same wrapper is used, but the entire response body is written in one shot and `end()` is called immediately, so the behaviour is indistinguishable from a normal response.

---

## 3. TypeScript ambient declaration for `awslambda`

`awslambda` is not on npm. It must be declared as an ambient global so TypeScript does not error. Two equally valid approaches:

**Option A — inline `declare const` at the top of `handler.ts`** (chosen; no extra file, keeps the bundle self-contained):

```ts
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
```

**Option B — a `.d.ts` shim** (e.g. `terraform/lambda/awslambda.d.ts`) with the same content as a `declare global` block. Cleaner for a larger codebase but unnecessary overhead here.

Option A is used because the declaration lives next to the code that uses it and the build script does not need to change.

---

## 4. Revised handler structure

### 4.1 What stays

- All imports (unchanged).
- Module-level client construction (`config`, `textract`, `bedrock`, `summarizer`) — reused across warm invocations.
- `statusForStage`, `jsonResponse`, `resolveIndexHtmlPath`, `serveIndex`, `parseUpload` — unchanged.
- All `src/` files, all Terraform files — unchanged (AC-9, requirement 3.5).

### 4.2 Non-streaming inner router (replaces current `handler`)

```ts
async function routeRequest(
  event: FunctionUrlEvent,
  stream: NodeJS.WritableStream
): Promise<void>
```

This function handles every route. For GET / and 404 it attaches HTTP metadata and writes the full body immediately. For POST /api/summarize it delegates to `streamSummary`.

The separation means:

- Non-streaming routes (`GET /`, `404`, parse errors) use `awslambda.HttpResponseStream.from` with a JSON content-type and write their entire body in one call.
- The streaming route calls `streamSummary`, which attaches SSE headers and writes chunks as they arrive.

### 4.3 Streaming helper

Mirrors `src/server.ts → streamSummary` exactly, adapted for the Lambda writable stream:

```ts
async function streamSummary(
  stream: NodeJS.WritableStream,
  summary: AsyncIterable<string>,
  timeoutMs: number
): Promise<void>
```

Logic:

1. Attach SSE headers via `awslambda.HttpResponseStream.from`.
2. Start a `setTimeout` for `timeoutMs`.
3. For each chunk: clear the timer on the first chunk, write a `delta` event.
4. On exhaustion: write a `done` event, call `stream.end()`.
5. On iterable error: write an `error` event, call `stream.end()`.
6. On timeout: write a timeout `error` event, call `stream.end()`.

### 4.4 Exported handler

```ts
export const handler = awslambda.streamifyResponse(routeRequest);
```

This is the only exported name. Lambda looks for `index.handler` in the bundle — the esbuild CJS output sets `exports.handler` from this export.

---

## 5. SSE wire format

Identical to the format emitted by `src/server.ts` and already consumed by `public/index.html`:

| Event | Wire form |
|-------|-----------|
| Text chunk | `data: {"type":"delta","text":"<chunk>"}\n\n` |
| Stream end | `data: {"type":"done"}\n\n` |
| Error | `data: {"type":"error","error":"<message>","stage":"summarization"}\n\n` |

Each message is written with a single `stream.write(...)` call to ensure Lambda flushes it immediately.

---

## 6. Response headers

### Streaming path (`POST /api/summarize` — success)

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Content-Type-Options: nosniff
```

`Transfer-Encoding: chunked` is set automatically by Lambda for streaming responses — the handler does not need to set it explicitly (and setting it manually can cause duplicate-header issues).

### Non-streaming paths (GET /, 404, 4xx errors)

```
Content-Type: application/json   (or text/html for GET /)
```

These are unchanged from the current handler.

---

## 7. Frontend compatibility

`public/index.html` already handles both response shapes:

- **SSE (`text/event-stream`)**: reads `delta`, `done`, and `error` events from the stream incrementally.
- **JSON fallback**: if the content-type is not `text/event-stream`, it attempts to parse the body as `{ summary }` or `{ error, stage }`.

After this fix the Lambda returns SSE for the summarize path, which matches what the local server already sends. The frontend JSON path remains as a fallback for non-streaming routes. **No changes to `public/index.html` are needed.**

---

## 8. Timeout handling

`config.summarizerTimeoutMs` (default 30 000 ms, sourced from the `SUMMARIZER_TIMEOUT_MS` environment variable) is passed into `streamSummary`. If no chunk arrives within that window, the timer fires, writes:

```
data: {"type":"error","error":"Summarization timed out.","stage":"summarization"}\n\n
```

and calls `stream.end()`. This matches the local server behaviour in `src/server.ts → streamSummary` exactly (AC-5, requirement 3.4).

---

## 9. Build — no changes required

The existing esbuild command:

```
npx esbuild handler.ts --bundle --platform=node --target=node20 --format=cjs --sourcemap --external:@aws-sdk/* --outfile=../.build/index.js
```

- `awslambda` is a runtime global, not an import, so esbuild never tries to bundle it. The `declare const` block is erased by TypeScript compilation and produces no bundle output.
- The CJS output format (`--format=cjs`) makes `export const handler = …` compile to `exports.handler = …`, which Lambda resolves as `index.handler`.
- `build.tf` and `terraform/lambda/package.json` are unchanged (AC-10, requirement 3.3).

---

## 10. Files changed

| File | Change |
|------|--------|
| `terraform/lambda/handler.ts` | Main change: add `declare const awslambda`, replace `handler` export with `awslambda.streamifyResponse` wrapper, extract `routeRequest`, add `streamSummary` |

| File | Unchanged |
|------|-----------|
| `public/index.html` | No change (AC-9) |
| `src/**` | No change (requirement 3.5) |
| `terraform/build.tf` | No change (AC-10) |
| `terraform/iam.tf` | No change |
| `terraform/variables.tf` | No change |
| `terraform/lambda/package.json` | No change |

---

## 11. Acceptance criteria mapping

| AC | Addressed by |
|----|-------------|
| AC-1: chunks arrive before summary completes | `streamSummary` writes each chunk immediately via `stream.write` |
| AC-2: SSE delta events carry text chunks | `delta` event written per chunk in `streamSummary` |
| AC-3: SSE done event terminates stream | `done` event written after iterable exhaustion |
| AC-4: SSE error event on summarizer failure | `error` event written in `catch` block of `streamSummary` |
| AC-5: timeout produces SSE error event | `setTimeout` in `streamSummary` writes timeout error event |
| AC-6: Content-Type is text/event-stream | Set in `HttpResponseStream.from` metadata for streaming path |
| AC-7: non-streaming paths unchanged | `serveIndex`, `jsonResponse`, error paths untouched |
| AC-8: export uses `awslambda.streamifyResponse` | `export const handler = awslambda.streamifyResponse(routeRequest)` |
| AC-9: no frontend changes | `public/index.html` not modified |
| AC-10: build succeeds without changes | `awslambda` global needs no bundle entry; esbuild command unchanged |
