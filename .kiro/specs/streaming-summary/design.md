# Design Document

## Overview

The streaming summary feature changes how the summary travels from Amazon Bedrock to the user's browser. Today every layer buffers the full text before passing it on — Bedrock's `InvokeModelCommand` blocks until the model finishes, `runPipeline` awaits the result, and the server writes a single JSON body. The change reverses that: Bedrock's streaming API yields text deltas as they are generated, the pipeline forwards an `AsyncIterable<string>` to the server, and the server writes each delta as a Server-Sent Events frame. The browser reads the SSE stream incrementally and appends each chunk to the DOM, producing the typewriter effect.

The Lambda deployment path is **out of scope** — it requires `streamifyResponse` and a Terraform `invoke_mode = "RESPONSE_STREAM"` change that is a separate infrastructure task. Only `src/server.ts` is updated on the server side.

## Architecture

```
Browser                           src/server.ts              src/summarizer.ts       Bedrock
  │                                    │                            │                   │
  │─── POST /api/summarize ───────────>│                            │                   │
  │                                    │── runPipeline ────────────>│                   │
  │                                    │                            │─ InvokeModelWith  │
  │                                    │                            │  ResponseStream ─>│
  │<── HTTP 200 text/event-stream ─────│                            │                   │
  │<── data: {"type":"delta","text":…} │<─── yield chunk ───────────│<── stream event ──│
  │   (append to DOM)                  │                            │                   │
  │<── data: {"type":"delta","text":…} │<─── yield chunk ───────────│<── stream event ──│
  │   (append to DOM)                  │                            │                   │
  │<── data: {"type":"done"} ──────────│       (stream exhausted)   │                   │
  │   (stop, re-enable submit)         │                            │                   │
```

## Components and Changes

### 1. `src/types.ts` — ProcessingResult

The success variant changes one field:

```ts
// Before
export type ProcessingResult =
  | { ok: true; summary: string }
  | { ok: false; error: StageError };

// After
export type ProcessingResult =
  | { ok: true; summary: AsyncIterable<string> }
  | { ok: false; error: StageError };
```

No other types change.

### 2. `src/summarizer.ts` — Interface and implementations

**Interface change:**

```ts
// Before
export interface Summarizer {
  summarize(text: string): Promise<string>;
}

// After
export interface Summarizer {
  summarize(text: string): AsyncIterable<string>;
}
```

**`BedrockSummarizer`** — replaces `InvokeModelCommand` with `InvokeModelWithResponseStreamCommand`. The Anthropic streaming protocol emits JSON lines; the relevant ones have `type: "content_block_delta"` and `delta.type: "text_delta"`. Each such event yields `delta.text` as one chunk:

```ts
async *summarize(text: string): AsyncIterable<string> {
  const body = JSON.stringify({ /* same request shape */ });
  const response = await this.client.send(
    new InvokeModelWithResponseStreamCommand({ modelId: this.modelId, body, ... })
  );
  for await (const event of response.body) {
    const chunk = JSON.parse(new TextDecoder().decode(event.chunk?.bytes));
    if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
      yield chunk.delta.text as string;
    }
  }
}
```

**`MockSummarizer`** — yields words with a 40 ms delay to simulate streaming:

```ts
async *summarize(text: string): AsyncIterable<string> {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  yield `Summary (${words.length} words): `;
  for (const word of words) {
    await new Promise(resolve => setTimeout(resolve, 40));
    yield word + " ";
  }
}
```

**`runSummarizer`** — removed. Its responsibilities migrate: empty-input checking and byte truncation stay in the pipeline; timeout enforcement moves into the SSE handler in `server.ts`.

### 3. `src/pipeline.ts` — Forward the stream without buffering

`runPipeline` no longer calls `runSummarizer`. It calls `summarizer.summarize(input)` directly and returns the `AsyncIterable<string>`:

```ts
// Empty-input guard and truncation stay here
if (extractedText.trim().length === 0) {
  return { ok: false, error: { stage: "summarization", message: "There is no text to summarize." } };
}
const input = truncateToBytes(extractedText, config.maxSummarizerInputBytes);
const summary = summarizer.summarize(input);
return { ok: true, summary };
```

`truncateToBytes` is moved from `summarizer.ts` to a shared utility (or inlined in `pipeline.ts`) since `runSummarizer` is going away.

### 4. `src/server.ts` — SSE response

`sendJson` is kept for error responses (pre-stream errors still return JSON). A new `streamSummary` function handles the success path:

```ts
async function streamSummary(
  res: http.ServerResponse,
  summary: AsyncIterable<string>,
  timeoutMs: number
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Transfer-Encoding": "chunked",
  });

  const timer = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ type: "error", error: "Summarization timed out.", stage: "summarization" })}\n\n`);
    res.end();
  }, timeoutMs);

  try {
    for await (const chunk of summary) {
      clearTimeout(timer); // cancel timeout once first chunk arrives
      res.write(`data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`);
    }
    clearTimeout(timer);
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ type: "error", error: `Summarization failed: ${message}`, stage: "summarization" })}\n\n`);
  } finally {
    res.end();
  }
}
```

`handleSummarize` is updated: if `result.ok` is true, it calls `streamSummary`; if false, it continues to call `sendJson` with the appropriate status code. The timeout value comes from `config.summarizerTimeoutMs`.

### 5. `public/index.html` — Typewriter renderer

The fetch call is rewritten to read `response.body` as a `ReadableStream`. A small SSE line parser buffers incomplete lines across chunks:

```js
const response = await fetch("/api/summarize", { method: "POST", body: formData });

// Pre-stream errors (input/extraction failures) still come back as JSON
if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
  const data = await response.json();
  showError((data.stage ? "[" + data.stage + "] " : "") + data.error);
  return;
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let summaryStarted = false;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // keep incomplete last line

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));

    if (event.type === "delta") {
      if (!summaryStarted) { show(resultEl); summaryStarted = true; }
      summaryTextEl.textContent += event.text;
    } else if (event.type === "done") {
      // stream complete — fall through to finally block
    } else if (event.type === "error") {
      if (summaryStarted) { hide(resultEl); summaryTextEl.textContent = ""; }
      showError((event.stage ? "[" + event.stage + "] " : "") + event.error);
    }
  }
}
```

## Key Design Decisions

**SSE over WebSockets:** SSE fits perfectly — it is unidirectional (server → client), works over plain HTTP/1.1 (no upgrade), is natively supported in every modern browser via `EventSource` or `fetch` + `ReadableStream`, and requires no library on either side. WebSockets would add unnecessary bidirectional complexity.

**`AsyncIterable<string>` over `ReadableStream<string>` in the summarizer:** `AsyncIterable` integrates naturally with `for await...of`, is idiomatic TypeScript/Node.js, and is what the Bedrock SDK itself returns from streaming commands. Wrapping it in a Web `ReadableStream` would add indirection without benefit at this layer.

**Timeout moves to the SSE handler:** `runSummarizer`'s `Promise.race` timeout cannot wrap an `AsyncIterable`. The SSE handler is a better location: it owns the response lifecycle and can write an `error` SSE_Event before closing, which the browser can display meaningfully.

**Pre-stream errors stay as JSON:** Input handling and text extraction errors are detected before any streaming begins. Returning a plain JSON error body for these (with the appropriate HTTP status code) keeps the existing error contract intact. The frontend detects these via `Content-Type` check.

**`truncateToBytes` stays in the pipeline:** The truncation guard is a cost-control measure that belongs before the model call, not inside the summarizer. It is inlined into `runPipeline` when `runSummarizer` is removed.

## Files Changed

| File | Change |
| --- | --- |
| `src/types.ts` | `ProcessingResult` success variant: `summary: string` → `summary: AsyncIterable<string>` |
| `src/summarizer.ts` | Interface: `Promise<string>` → `AsyncIterable<string>`; `BedrockSummarizer` uses `InvokeModelWithResponseStreamCommand`; `MockSummarizer` yields word-by-word with delay; `runSummarizer` removed; `truncateToBytes` moved/exported |
| `src/pipeline.ts` | Remove `runSummarizer` call; add empty-input guard and truncation inline; return `summarizer.summarize(input)` directly |
| `src/server.ts` | Add `streamSummary` function; update `handleSummarize` to call `streamSummary` on success; keep `sendJson` for error responses |
| `public/index.html` | Replace `await response.json()` with `ReadableStream` reader; add SSE line parser; incremental DOM append; content-type fallback for pre-stream errors |
