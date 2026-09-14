# Implementation Plan: Text Summary Extractor

## Overview

This plan builds the proof-of-concept CLI in small, incremental TypeScript steps. It starts with project scaffolding and shared types, adds configuration, then implements each pipeline stage (input handling, text/OCR extraction, summarization, reporting), and finishes by wiring everything together through the orchestrator and CLI entry point. Each task builds on the previous one so there is no orphaned code. Per the POC scope, there are no test tasks.

## Tasks

- [x] 1. Set up project structure and shared types
  - Initialize a TypeScript Node project (`package.json`, `tsconfig.json`) with the `src/` directory
  - Add dependencies: `@aws-sdk/client-textract`, `@aws-sdk/client-bedrock-runtime`, and a zip-reading library for archive enumeration
  - Create `src/types.ts` defining `Stage`, `StageError`, `Result`, `InputClassification`, `ArchiveImage`, `ExcludedEntry`, `ImageFailure`, `ExtractionResult`, and `ProcessingResult`
  - _Requirements: 1.1, 6.3_

- [x] 2. Implement configuration resolution
  - Create `src/config.ts` defining the `Config` interface and a resolver that reads from environment variables with defaults
  - Default `maxInputSizeBytes` to 10,485,760 and clamp/validate to the inclusive range 1..104,857,600, falling back to the default when out of range
  - Provide POC defaults for `maxSummarizerInputBytes`, `summarizerTimeoutMs`, `bedrockModelId`, and `awsRegion`
  - _Requirements: 2.1, 5.4, 5.5_

- [x] 3. Implement input classification and validation
  - [x] 3.1 Implement extension classification and path checks in `src/inputHandler.ts`
    - Classify `.txt` as text and `.zip` as archive case-insensitively; return a descriptive error naming the detected extension for anything else
    - Return a "not found" error when the path does not exist and a "could not be accessed" error when it exists but cannot be read
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 3.2 Implement text-document size enforcement
    - Compare the text file byte size against `Max_Input_Size` and reject if strictly greater, stating the configured limit
    - Ensure rejection happens before any AWS call
    - _Requirements: 2.2_

  - [x] 3.3 Implement archive enumeration, exclusion, and size enforcement
    - Enumerate `.png`/`.jpg`/`.jpeg` entries (case-insensitive) as `ArchiveImage` entries, recording all other entries as `ExcludedEntry` with reason `unsupported-type` and no OCR call
    - Return the "no supported images" error when there are zero supported images
    - Sum uncompressed entry sizes and reject if strictly greater than `Max_Input_Size`, stating the limit
    - _Requirements: 1.5, 1.6, 2.3, 2.4_

- [x] 4. Checkpoint - validate input handling
  - Ensure the project compiles and input handling behaves as designed, ask the user if questions arise.

- [x] 5. Implement text document reading
  - Create `src/textReader.ts` with `readTextDocument` that reads and decodes the file as UTF-8 without any OCR
  - Return a "could not be decoded" error on decode failure and a "document is empty" error when content is empty or whitespace-only
  - Return the decoded content as `Extracted_Text` on success
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 6. Implement OCR extraction from archive images
  - [x] 6.1 Implement per-image Textract calls with retry in `src/ocrExtractor.ts`
    - Call `DetectDocumentTextCommand` exactly once per supported image, retrying up to 2 additional times only on transient errors (throttling / 5xx / network)
    - Never invoke the OCR service for excluded entries; join returned `LINE` blocks into per-image text
    - Record images that still fail after retries in `imageFailures` and continue processing the rest
    - _Requirements: 4.1, 4.3, 4.5_

  - [x] 6.2 Aggregate extracted text and enforce non-empty result
    - Concatenate per-image text in ascending order of entry name, separated by a newline, into a single `Extracted_Text`
    - Return a "no text was extracted" error when no image yields any non-whitespace text, carrying `imageFailures` and `excluded` into the `ExtractionResult`
    - _Requirements: 4.2, 4.4_

- [x] 7. Implement summarization
  - Create `src/summarizer.ts` with `summarize` that guards against empty/whitespace-only input by returning a "no text to summarize" error without calling Bedrock
  - Truncate `text` to `Max_Summarizer_Input` bytes when the UTF-8 byte length exceeds it before invoking Bedrock
  - Invoke Bedrock with a summarization prompt raced against the configured timeout; return a "summarization failed" error on error/timeout and the summary text on success
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 8. Implement result reporting
  - Create `src/reporter.ts` with `report` that prints the summary on success and, when `affectedImages` is non-empty, prints the total count and each affected file name alongside the summary
  - On failure, print a single descriptive message tagged with the failed stage and print no summary
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 9. Implement pipeline orchestration
  - Create `src/pipeline.ts` that threads the `ProcessingResult` through the stages, short-circuiting on the first `StageError`
  - Branch on classification: text → `readTextDocument`; archive → `extractFromArchive`; converge on a single `Extracted_Text` then call `summarize`
  - Build `affectedImages` as the union of excluded entry names and OCR-failed image names for a successful run
  - _Requirements: 1.1, 4.2, 6.4_

- [x] 10. Implement CLI entry point and wire everything together
  - Create `src/cli.ts` that parses the input path argument, loads config, constructs the Textract and Bedrock clients, invokes the pipeline, and passes the result to `report`
  - Exit with a status reflecting the reported result
  - _Requirements: 1.1, 6.1, 6.3_

- [x] 11. Final checkpoint - end-to-end wiring
  - Ensure the project compiles and the CLI runs against a sample `.txt` and a sample `.zip`, ask the user if questions arise.

## Notes

- This is a proof of concept; per the design, automated tests are out of scope and no test tasks are included.
- Each task references specific requirements for traceability.
- Checkpoints ensure incremental validation as stages come together.
- The flow is intentionally linear and straightforward, favoring readability over abstraction.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2", "3.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "5", "8"] },
    { "id": 3, "tasks": ["6.1"] },
    { "id": 4, "tasks": ["6.2", "7"] },
    { "id": 5, "tasks": ["9"] },
    { "id": 6, "tasks": ["10"] }
  ]
}
```
