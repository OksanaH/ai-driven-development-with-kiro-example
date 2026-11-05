# Implementation Plan: Streaming Summary

## Overview

Thread streaming through every layer of the stack so the summary appears in the browser progressively as the model generates it. The work flows bottom-up: types first, then the summarizer, then the pipeline, then the server, then the frontend, with a final build verification step.

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [1] },
    { "wave": 2, "tasks": [2] },
    { "wave": 3, "tasks": [3, 4, 5] },
    { "wave": 4, "tasks": [6] },
    { "wave": 5, "tasks": [7, 9] },
    { "wave": 6, "tasks": [8, 10] },
    { "wave": 7, "tasks": [11] }
  ]
}
```

## Tasks

- [x] 1. Update `ProcessingResult` to carry an `AsyncIterable<string>` summary
  - In `src/types.ts`, change the success variant's `summary` field from `string` to `AsyncIterable<string>`
  - No other types in this file need to change
  - **Requirement:** R2.1
  - **File:** `src/types.ts`

- [x] 2. Update the `Summarizer` interface and extract `truncateToBytes`
  - In `src/summarizer.ts`, change the `summarize` signature from `Promise<string>` to `AsyncIterable<string>`
  - Move the `truncateToBytes` helper out of `summarizer.ts` — either inline it in `src/pipeline.ts` or extract it to `src/utils.ts` — so it remains usable after `runSummarizer` is removed in task 5
  - **Requirement:** R1.1, R2.4
  - **Files:** `src/summarizer.ts`, `src/pipeline.ts` (or `src/utils.ts`)

- [x] 3. Rewrite `BedrockSummarizer` to stream deltas from Bedrock
  - In `src/summarizer.ts`, import `InvokeModelWithResponseStreamCommand` from `@aws-sdk/client-bedrock-runtime` and remove the `InvokeModelCommand` import
  - Rewrite `summarize` as an `async` generator: send the streaming command, iterate `response.body`, decode each `event.chunk.bytes`, and `yield` the `delta.text` field from events whose `type` is `"content_block_delta"` and `delta.type` is `"text_delta"`
  - Allow any error thrown during iteration to propagate naturally so the caller receives it
  - **Requirement:** R1.2, R1.4
  - **File:** `src/summarizer.ts`

- [x] 4. Rewrite `MockSummarizer` to yield word-by-word with a delay
  - In `src/summarizer.ts`, rewrite `summarize` as an `async` generator
  - First `yield` the header string `"Summary (N words): "` (same word count as the current mock)
  - Then loop over each word, `await` a 40 ms `setTimeout`, and `yield` the word followed by a space
  - The full concatenated output must equal what the current `MockSummarizer` returns today
  - **Requirement:** R1.3
  - **File:** `src/summarizer.ts`

- [x] 5. Remove `runSummarizer` from `src/summarizer.ts`
  - Delete the `runSummarizer` export entirely
  - Its empty-input guard and truncation logic move to `runPipeline` (task 6); its timeout moves to `streamSummary` in `server.ts` (task 7)
  - **Requirement:** R2.4
  - **File:** `src/summarizer.ts`

- [x] 6. Update `runPipeline` to forward the `AsyncIterable` without buffering
  - In `src/pipeline.ts`, remove the `runSummarizer` import and call
  - Add an empty-input guard after text extraction: if the extracted text is blank or whitespace-only, return `{ ok: false, error: { stage: "summarization", message: "There is no text to summarize." } }`
  - Apply `truncateToBytes` to the extracted text before calling the summarizer
  - Call `summarizer.summarize(input)` and return `{ ok: true, summary }` immediately — do not iterate or `await` the iterable
  - **Requirement:** R2.2, R2.3, R2.4
  - **File:** `src/pipeline.ts`

- [x] 7. Add `streamSummary` to `src/server.ts`
  - Write a new `async function streamSummary(res: http.ServerResponse, summary: AsyncIterable<string>, timeoutMs: number): Promise<void>` that:
    - Calls `res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Transfer-Encoding": "chunked" })`
    - Starts a `setTimeout` for `timeoutMs`; if it fires before the first chunk, writes `data: {"type":"error","error":"Summarization timed out.","stage":"summarization"}\n\n` and calls `res.end()`
    - Iterates the `AsyncIterable`; on the first chunk, clears the timeout; writes each chunk as `data: {"type":"delta","text":"<chunk>"}\n\n`
    - When the iterable is exhausted, writes `data: {"type":"done"}\n\n` and calls `res.end()`
    - If the iterable throws, writes `data: {"type":"error","error":"...","stage":"summarization"}\n\n` and calls `res.end()`
  - **Requirement:** R3.1, R3.2, R3.3, R3.5, R3.6
  - **File:** `src/server.ts`

- [x] 8. Update `handleSummarize` in `src/server.ts` to call `streamSummary`
  - When `result.ok` is `true`, call `await streamSummary(res, result.summary, config.summarizerTimeoutMs)` instead of `sendJson`
  - When `result.ok` is `false`, continue to call `sendJson` with the same HTTP status codes as today (input-handling → 400, text-extraction → 422, summarization → 500)
  - **Requirement:** R3.1, R3.4
  - **File:** `src/server.ts`

- [x] 9. Rewrite the frontend fetch handler in `public/index.html` to read the SSE stream
  - Add `Accept: "text/event-stream"` to the `fetch` call options
  - After the `fetch` resolves, check `response.headers.get("content-type")`: if it does not start with `"text/event-stream"`, parse the body as JSON and display the error with `showError` (same as today)
  - Otherwise, call `response.body.getReader()` and enter a `read()` loop
  - Maintain a string `buffer` to accumulate incomplete SSE lines across multiple `read()` calls; split on `"\n"`, keep the last (possibly incomplete) line in the buffer
  - For each complete line that starts with `"data: "`, parse the JSON payload and act on its `type`:
    - `"delta"` — on first delta call `show(resultEl)`; append `event.text` to `summaryTextEl.textContent`
    - `"done"` — break the loop
    - `"error"` — if the result container is visible, hide it and clear `summaryTextEl.textContent`; call `showError` with the stage-prefixed message; break the loop
  - In the `finally` block, call `hide(statusEl)` and set `submitBtn.disabled = false`
  - **Requirement:** R4.1, R4.2, R4.3, R4.4, R4.5, R4.6, R4.7
  - **File:** `public/index.html`

- [x] 10. Update the README to mention streaming
  - In `readme.MD`, add one or two sentences to the "How it works" section noting that the summary streams progressively to the browser via Server-Sent Events
  - **File:** `readme.MD`

- [x] 11. Build and verify there are no TypeScript errors
  - Run `npm run build` and confirm it exits with zero errors
  - Fix any type errors that arise from the `AsyncIterable<string>` change (most likely in `pipeline.ts` and `server.ts` where `ProcessingResult.summary` is referenced)
  - **Command:** `npm run build`

## Notes

- Tasks 3, 4, and 5 all modify `src/summarizer.ts` and can be done in a single editing pass once task 2 is complete.
- The Lambda handler (`terraform/lambda/handler.ts`) is intentionally not changed — Lambda streaming requires infrastructure changes (`RESPONSE_STREAM` invoke mode) that are out of scope for this feature.
- The `summarizerTimeoutMs` config value already exists (`config.ts`) and is re-used unchanged as the `Stream_Timeout` for the SSE handler.
