# Bug Fix: Lambda Streaming Summary

## Overview

The Lambda deployment of the Text Summary Extractor does not stream the summary progressively to the browser. Instead it buffers all Bedrock response chunks and returns the full summary in a single JSON response, so users see no output until the entire summary is ready. The local Node HTTP server (`src/server.ts`) already solves this correctly using Server-Sent Events (SSE); the Lambda handler (`terraform/lambda/handler.ts`) needs to be brought to the same behaviour using the Lambda streaming API.

---

## 1. Current (Broken) Behaviour

### 1.1 Full-buffer response

The Lambda handler iterates over `result.summary` (an `AsyncIterable<string>` produced by `BedrockSummarizer`) and collects every chunk into a local array before responding:

```ts
const chunks: string[] = [];
for await (const chunk of result.summary) {
  chunks.push(chunk);
}
return jsonResponse(200, { summary: chunks.join("") });
```

The response is therefore a single JSON object `{ summary: "…full text…" }` that is not sent until Bedrock finishes generating the entire summary.

### 1.2 User-visible impact

The browser receives no content during generation. The "Summarizing…" status indicator stays on screen for the full duration of the Bedrock call (potentially many seconds for long documents), and the summary appears all at once. This is noticeably worse than the local experience.

### 1.3 Root cause

Lambda Function URLs support streaming through the `awslambda.streamifyResponse` wrapper, which provides a writable `responseStream` instead of a return value. The handler does not use this wrapper.

---

## 2. Expected Behaviour

### 2.1 Progressive rendering in the browser

Each text chunk yielded by the `Summarizer` must be flushed to the browser as soon as it is received from Bedrock, in the same way the local server already does. The user should see words or sentences appear incrementally while the model is still generating.

### 2.2 SSE wire format

The streaming response must use the Server-Sent Events format already consumed by the frontend in `public/index.html`. Every Bedrock chunk must be written as a `delta` event:

```
data: {"type":"delta","text":"<chunk>"}\n\n
```

When the iterable is exhausted a `done` event must be sent:

```
data: {"type":"done"}\n\n
```

If the iterable throws, an `error` event must be sent before closing the stream:

```
data: {"type":"error","error":"<message>","stage":"summarization"}\n\n
```

### 2.3 Response headers

The streaming response must include:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`

### 2.4 Non-streaming paths remain JSON

Routes that do not stream — `GET /`, any 4xx/5xx error returned before a stream starts — must continue to return JSON responses with the existing shape (`{ summary }` or `{ error, stage }`). The fix must not change the behaviour of these paths.

---

## 3. Constraints

### 3.1 Lambda streaming API

Lambda Function URLs support streaming via the `awslambda.streamifyResponse` helper available in the Node 20 runtime. The handler must be wrapped with this helper. The `handler` export signature changes from `(event) => Promise<FunctionUrlResponse>` to a streamify-compatible form.

### 3.2 Frontend is already compatible

`public/index.html` already handles SSE (`text/event-stream`) responses from the local server. No frontend changes are required; the Lambda handler must emit the same SSE format.

### 3.3 esbuild bundle

The handler is compiled with esbuild (targeting Node 20 CJS) and deployed as a zip. The `awslambda` global is available in the Lambda runtime but is not an npm package, so it must be referenced as a global (no import needed, or declared with `declare const`). The build script must not change.

### 3.4 Timeout handling

The existing `summarizerTimeoutMs` config value must still be honoured in the Lambda path. If no chunk arrives within the timeout window, an SSE `error` event must be written and the stream closed, matching the local server behaviour in `src/server.ts → streamSummary`.

### 3.5 Terraform / infrastructure

The Terraform configuration does not need to change for response streaming on Lambda Function URLs — streaming is enabled by the `awslambda.streamifyResponse` wrapper alone. No IAM, resource, or deployment changes are required.

### 3.6 No new runtime dependencies

The fix must use the `awslambda` global and the existing Node built-ins. No new npm packages should be introduced.

---

## 4. Acceptance Criteria

### AC-1: Chunks arrive before the summary completes

When a file is uploaded via the deployed Lambda URL, the browser begins displaying summary text before the Bedrock response is fully received. (Verified manually by uploading a document long enough to take several seconds to summarise.)

### AC-2: SSE delta events carry text chunks

Each chunk yielded by `BedrockSummarizer.summarize` is written to the response stream as a separate `data: {"type":"delta","text":"…"}\n\n` line. The full concatenated text of all `delta` events equals the summary the model produced.

### AC-3: SSE done event terminates the stream

After the last chunk, a `data: {"type":"done"}\n\n` event is written and the response stream is closed. The browser stops showing the "Summarizing…" indicator.

### AC-4: SSE error event on summarizer failure

If `BedrockSummarizer.summarize` throws during iteration, a `data: {"type":"error","error":"<message>","stage":"summarization"}\n\n` event is written and the stream is closed. The browser displays the error message.

### AC-5: Timeout produces an SSE error event

If no chunk arrives within `summarizerTimeoutMs`, a `data: {"type":"error","error":"Summarization timed out.","stage":"summarization"}\n\n` event is written and the stream is closed.

### AC-6: Content-Type header is text/event-stream

The HTTP response for `POST /api/summarize` (success path) carries `Content-Type: text/event-stream` and `Cache-Control: no-cache`.

### AC-7: Non-streaming paths are unchanged

`GET /` still returns the HTML frontend. Validation errors (missing file, unsupported type, oversized file) still return JSON `{ error, stage }` with the appropriate 4xx status code. These paths are not affected by the streaming change.

### AC-8: Handler export uses awslambda.streamifyResponse

The exported `handler` is wrapped with `awslambda.streamifyResponse(…)`. The wrapper is used only for the `POST /api/summarize` path; non-streaming routes continue to write a complete response and call `responseStream.end()` immediately.

### AC-9: No frontend changes required

`public/index.html` is not modified. The fix is entirely within `terraform/lambda/handler.ts`.

### AC-10: Build succeeds without changes to the build script

Running the existing esbuild bundle command (`npx esbuild handler.ts …`) in `terraform/lambda/` produces a valid `terraform/.build/index.js` with no errors.
