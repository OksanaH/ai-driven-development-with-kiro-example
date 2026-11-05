# Requirements Document

## Introduction

The Streaming Summary feature incrementally delivers the generated summary to the browser as it is produced, rather than waiting for the full text before displaying anything. The user sees words appearing progressively — a typewriter-style experience — which provides immediate feedback that the model is working and makes long summaries feel faster to receive.

The feature threads through every layer of the stack: the Bedrock SDK call switches from a blocking invocation to a streaming one, the server response switches from a single buffered JSON body to a Server-Sent Events (SSE) stream, and the frontend switches from a one-shot DOM assignment to an incremental reader that appends each arriving chunk. The mock summarizer is updated to simulate the same behaviour so the feature works in offline mode too. The Lambda deployment path is out of scope for this feature; only the local `server.ts` path is changed.

## Glossary

- **Summary_Stream**: The sequence of text chunks produced by the Summarizer incrementally, collectively forming the complete Summary.
- **SSE_Endpoint**: The upgraded `POST /api/summarize` endpoint that responds with a `text/event-stream` body instead of a single JSON object.
- **SSE_Event**: A single Server-Sent Events frame emitted by the SSE_Endpoint. Each frame is either a `delta` event carrying a text chunk, a `done` event signalling the end of the stream, or an `error` event carrying a stage-tagged error message.
- **Streaming_Summarizer**: The upgraded `Summarizer` implementation (both Bedrock and mock) whose `summarize` method returns an `AsyncIterable<string>` instead of a `Promise<string>`.
- **Typewriter_Renderer**: The frontend logic that reads the SSE_Endpoint response body as a `ReadableStream`, parses each SSE_Event, and appends `delta` text to the summary display element progressively.
- **Stream_Timeout**: The maximum wall-clock duration the server waits for the first chunk to arrive from the Streaming_Summarizer before aborting the stream with an error.

## Requirements

### Requirement 1: Streaming Summarizer Interface

**User Story:** As a developer, I want the Summarizer contract to support incremental output, so that both the Bedrock and mock implementations can emit text progressively without changing the pipeline's structure.

#### Acceptance Criteria

1. THE `Summarizer` interface SHALL define `summarize(text: string): AsyncIterable<string>` as its contract in place of the current `Promise<string>` return type.
2. WHEN the `BedrockSummarizer` is invoked, it SHALL use `InvokeModelWithResponseStreamCommand` and yield each incremental text delta received from Amazon Bedrock as a separate chunk through the `AsyncIterable`.
3. WHEN the `MockSummarizer` is invoked, it SHALL yield the summary word-by-word (splitting on whitespace) through the `AsyncIterable`, with a fixed inter-word delay of 40 ms, producing the same deterministic text as the current mock.
4. IF the Bedrock streaming call returns an error at any point during iteration, the `BedrockSummarizer` SHALL propagate the error by throwing from the `AsyncIterable`.

### Requirement 2: Streaming Pipeline Result

**User Story:** As a developer, I want the pipeline to propagate the summary stream without buffering it, so the server can start writing to the client the moment the first chunk arrives.

#### Acceptance Criteria

1. THE `ProcessingResult` success variant SHALL carry `summary: AsyncIterable<string>` instead of `summary: string`.
2. WHEN `runPipeline` reaches the summarization stage, it SHALL return the `AsyncIterable<string>` from the Streaming_Summarizer directly without awaiting or buffering it.
3. THE input handling and text extraction stages SHALL remain unchanged and SHALL still resolve to a `Result` before the stream begins.
4. THE `runSummarizer` helper function SHALL be removed or replaced because its `Promise.race` timeout pattern is incompatible with an `AsyncIterable`; timeout enforcement SHALL move to the SSE_Endpoint (Requirement 3).

### Requirement 3: Server-Sent Events Endpoint

**User Story:** As a user, I want the server to begin sending summary text the moment the model produces it, so I see progress immediately instead of waiting for the full response.

#### Acceptance Criteria

1. WHEN `POST /api/summarize` succeeds through the input-handling and text-extraction stages, THE SSE_Endpoint SHALL respond with HTTP 200, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Transfer-Encoding: chunked` (no `Content-Length` header).
2. THE SSE_Endpoint SHALL emit one SSE_Event per chunk received from the Summary_Stream, formatted as `data: <json>\n\n` where `<json>` is `{"type":"delta","text":"<chunk>"}`.
3. WHEN the Summary_Stream is exhausted without error, THE SSE_Endpoint SHALL emit a final `data: {"type":"done"}\n\n` frame and close the response.
4. IF an error occurs during input handling or text extraction (before the stream starts), THE SSE_Endpoint SHALL respond with the appropriate HTTP error status code and a JSON body `{"error":"...","stage":"..."}` — identical to the current non-streaming error behaviour.
5. IF the Streaming_Summarizer throws an error mid-stream, THE SSE_Endpoint SHALL emit `data: {"type":"error","error":"...","stage":"summarization"}\n\n` and close the response.
6. IF no chunk is received from the Streaming_Summarizer within the Stream_Timeout duration, THE SSE_Endpoint SHALL abort the stream and emit an `error` SSE_Event with stage `summarization`.

### Requirement 4: Typewriter Frontend Renderer

**User Story:** As a user, I want the summary to appear word-by-word (or chunk-by-chunk) as it streams in, so I know the app is working and can start reading immediately.

#### Acceptance Criteria

1. WHEN the user submits a file, THE Web_Frontend SHALL send `POST /api/summarize` with `Accept: text/event-stream` and read the response body as a `ReadableStream` using `response.body.getReader()`.
2. WHEN the first `delta` SSE_Event arrives, THE Web_Frontend SHALL make the result container visible and begin appending chunk text to the summary display element.
3. FOR each subsequent `delta` SSE_Event, THE Web_Frontend SHALL append the chunk's `text` value to the summary display element.
4. WHEN a `done` SSE_Event is received, THE Web_Frontend SHALL stop reading and mark the submission as complete (re-enable the submit button, hide the status indicator).
5. IF an `error` SSE_Event is received at any point, THE Web_Frontend SHALL display the error message (with its stage prefix) and hide any partially rendered summary text, consistent with existing error display behaviour.
6. IF the server returns a non-`text/event-stream` response (i.e., a pre-stream error), THE Web_Frontend SHALL fall back to parsing it as JSON and displaying the error using the existing error display logic.
7. THE Web_Frontend SHALL display a "Summarizing…" status indicator from the moment the file is submitted until either a `done` or `error` event is received.
