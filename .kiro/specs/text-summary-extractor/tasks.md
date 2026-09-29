# Implementation Plan: Text Summary Extractor

## Overview

This plan adapts the existing CLI/archive codebase into the new proof-of-concept **local web app**: a browser uploads a single file (`.txt` or one `.jpg`/`.jpeg`), a local HTTP server runs the pipeline over the uploaded bytes, and the frontend displays the returned `{ summary }` or `{ error, stage }`. The work proceeds in small, incremental TypeScript steps that each build on the previous one: first reshape the shared types and config, then rework each pipeline stage to operate on in-memory bytes (dropping all archive/zip and multi-image logic), define a `Summarizer` interface with a real `BedrockSummarizer` (default) and a `MockSummarizer` (offline/test) behind it, and finally add the frontend asset and the HTTP server that wires everything together. Textract OCR runs on the image path and Amazon Bedrock performs summarization. Per the POC scope, there are no test tasks.

## Tasks

- [ ] 1. Reshape shared types for single-file, in-memory scope
  - In `src/types.ts`, add `UploadedFile { filename: string; bytes: Uint8Array }`
  - Change `InputClassification` to `{ kind: "text"; bytes: Uint8Array } | { kind: "image"; bytes: Uint8Array }`
  - Reduce `ProcessingResult` to `{ ok: true; summary: string } | { ok: false; error: StageError }`
  - Remove the archive/multi-image types: `ArchiveImage`, `ExcludedEntry`, `ImageFailure`, and `ExtractionResult`
  - Keep `Stage`, `StageError`, and `Result<T, E>` as-is
  - _Requirements: 1.1, 6.4_

- [ ] 2. Add the HTTP port to configuration
  - In `src/config.ts`, add `httpPort: number` to the `Config` interface
  - Resolve it from an environment variable with a POC default of `3000`
  - Leave `bedrockModelId` / `awsRegion` in place for a future real Bedrock implementation
  - _Requirements: 6.1_

- [ ] 3. Rework input classification to operate on uploaded bytes
  - Rewrite `src/inputHandler.ts` so `classifyAndValidate(file: UploadedFile | undefined, config: Config)` operates on in-memory bytes with no filesystem access and no zip logic
  - Missing/undefined `file` → "a file is required" input-handling error
  - Classify by extension from `file.filename` (case-insensitive): `.txt` → text, `.jpg`/`.jpeg` → image; any other extension → descriptive error naming the detected extension
  - Unreadable/empty upload buffer → "could not be accessed" error
  - Reject when `file.bytes.byteLength` is strictly greater than `maxInputSizeBytes` (applies to both text and image), stating the configured limit — before any AWS call
  - On success return the `{ kind, bytes }` classification carrying the bytes forward
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.2, 2.3_

- [ ] 4. Rework text reading to decode in-memory bytes
  - Rewrite `src/textReader.ts` with `readTextBytes(bytes: Uint8Array): Result<string, StageError>` that decodes UTF-8 with `fatal: true` from memory (no path read)
  - Undecodable bytes → "could not be decoded" error
  - Empty or whitespace-only content → "document is empty" error
  - Otherwise return the decoded content as the Extracted_Text
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 5. Rework OCR extraction for a single image
  - Rewrite `src/ocrExtractor.ts` with `extractFromImage(bytes: Uint8Array, textract: TextractClient): Promise<Result<string, StageError>>`
  - Issue a single `DetectDocumentTextCommand` with the image bytes, retrying up to 2 additional times only on transient errors (throttling / 5xx / network)
  - On success, join the returned `LINE` blocks into one string
  - Still failing after retries → "text extraction failed" error (summarizer not invoked)
  - Detected text with no non-whitespace character → "no text extracted" error
  - Remove all archive/multi-image aggregation and excluded-entry handling
  - _Requirements: 4.1, 4.2, 4.3_

- [ ] 6. Checkpoint - validate input handling and extraction
  - Ensure the project compiles after the types/config/input/text/OCR rework, ask the user if questions arise.

- [ ] 7. Define the Summarizer interface with Bedrock and mock implementations
  - Rewrite `src/summarizer.ts` to define `interface Summarizer { summarize(text: string): Promise<string> }`
  - Implement `class BedrockSummarizer implements Summarizer` (default) constructed with a `BedrockRuntimeClient` and `modelId`, calling `InvokeModelCommand` with the Anthropic Messages API (`anthropic_version: "bedrock-2023-05-31"`, a `max_tokens` ceiling, a summarization system prompt, the text as one user turn), decoding the response and joining its `text` blocks; throw if the model returns an empty summary
  - Implement `class MockSummarizer implements Summarizer` producing a deterministic placeholder derived only from the input (`"Summary (N words): <text>"`), with no AWS call, for offline runs and tests
  - Add `runSummarizer(text: string, summarizer: Summarizer, config: Config): Promise<Result<string, StageError>>` that guards empty/whitespace-only input ("no text to summarize", summarizer not invoked), truncates `text` to `maxSummarizerInputBytes` by UTF-8 byte length, and races the summarize call against `summarizerTimeoutMs` ("summarization failed" on error/timeout)
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [ ] 8. Rework the pipeline for the single-file byte flow
  - Rewrite `src/pipeline.ts` with `runPipeline(file: UploadedFile | undefined, config: Config, textract: TextractClient, summarizer: Summarizer): Promise<ProcessingResult>`
  - Stage 1: `classifyAndValidate(file, config)`
  - Stage 2: branch on classification — text → `readTextBytes(bytes)`, image → `extractFromImage(bytes, textract)` — converging on a single Extracted_Text
  - Stage 3: `runSummarizer(text, summarizer, config)`
  - Short-circuit on the first `StageError`, returning `{ ok: false, error }`; on success return `{ ok: true, summary }`
  - Drop the Bedrock client parameter and all `affectedImages` logic
  - _Requirements: 1.1, 4.2, 6.4_

- [ ] 9. Add the web frontend asset
  - Create `public/index.html`: a single static page with a file input restricted via `accept=".txt,.jpg,.jpeg"` and a submit button
  - On submit, POST the file to `/api/summarize` as `multipart/form-data` using `fetch`
  - On a `{ summary }` response, render the summary in a result area; on an `{ error, stage }` response, render the error message (optionally noting the stage) and show no summary
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 10. Implement the HTTP server as the primary entry point
  - Create `src/server.ts` with `startServer(config: Config, textract: TextractClient, summarizer: Summarizer): http.Server` built on Node's `http` module
  - `GET /` responds `200 text/html` serving `public/index.html`
  - `POST /api/summarize` parses the uploaded file (minimal multipart parsing or a small well-known dependency such as `busboy` — keep it simple), builds an `UploadedFile { filename, bytes }`, and runs `runPipeline` with the `TextractClient` and injected `Summarizer`
  - In the runnable entry point (`require.main === module`), construct a `TextractClient`, a `BedrockRuntimeClient`, and a `BedrockSummarizer(bedrock, config.bedrockModelId)`, then call `startServer`
  - Respond `200 application/json { "summary" }` on success and `4xx/5xx application/json { "error", "stage" }` on failure; a missing file maps to an input-handling error
  - Listen on `config.httpPort`
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 11. Wire dependencies, scripts, and the CLI so everything compiles
  - Update `package.json`: add a `"serve": "node dist/server.js"` script, point `main` (and `bin` if kept) appropriately, and add the multipart dependency if one is used; keep `@aws-sdk/client-bedrock-runtime` (used by `BedrockSummarizer`) alongside `@aws-sdk/client-textract`, and remove the `adm-zip` dependency that is no longer needed
  - Ensure `tsc` emits `dist/server.js`, and confirm `public/index.html` is available to the running server (served via a path relative to the project root)
  - Update `src/cli.ts` so it still compiles: either adapt it to read a file from disk into an `UploadedFile` and call the new `runPipeline` with a `Summarizer` (a `MockSummarizer` keeps the CLI runnable offline), or de-emphasize it as an optional secondary entry — but it must not reference removed types
  - _Requirements: 6.1_

- [ ] 12. Final checkpoint - build and manual run
  - Build with `tsc`, start the server locally (`serve`), open the frontend, upload a sample `.txt`, and confirm a summary is displayed. With the default `BedrockSummarizer` this requires AWS credentials and Bedrock access; injecting `MockSummarizer` validates the flow offline. Ask the user if questions arise.

## Notes

- This is a proof of concept; per the design, automated tests are out of scope and no test tasks are included.
- The default `BedrockSummarizer` calls Amazon Bedrock, so the text path requires AWS credentials; injecting `MockSummarizer` runs the text path fully locally. Textract OCR runs on the JPEG path and Bedrock summarizes the extracted text.
- Each task references specific requirements for traceability.
- Checkpoints ensure incremental validation as the codebase is reshaped from the previous CLI/archive implementation.
- The flow is intentionally linear and straightforward, favoring readability over abstraction.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2"] },
    { "id": 1, "tasks": ["3", "4", "5", "7", "9"] },
    { "id": 2, "tasks": ["8"] },
    { "id": 3, "tasks": ["10"] },
    { "id": 4, "tasks": ["11"] }
  ]
}
```
