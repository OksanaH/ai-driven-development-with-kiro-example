# Text Summary Extractor

A proof-of-concept web app that produces a concise summary from a single uploaded file. Upload a plain-text file (`.txt`) or a JPEG image (`.jpg` / `.jpeg`) through a simple browser UI and get back a summary — or a clear, stage-specific error.

- **Text files** are read directly (no OCR cost).
- **JPEG images** are run through [Amazon Textract](https://aws.amazon.com/textract/) for OCR, then summarized.
- **Summarization** goes through a pluggable `Summarizer` interface. The default implementation calls [Amazon Bedrock](https://aws.amazon.com/bedrock/) (Anthropic Claude Messages API); a deterministic mock is retained for offline runs and tests.

> This is a learning/demo project built with [Kiro](https://kiro.dev)'s spec-driven workflow. Cost efficiency is an explicit goal: selective service calls, input-size limits, and no redundant AWS invocations.

## How it works

The app runs a small HTTP server (Node's built-in `http`, no framework) that serves a single-page frontend and one upload endpoint. Each upload is threaded through a three-stage pipeline that short-circuits on the first error, so the response always names exactly one failed stage.

```
Browser ──POST /api/summarize──> Server ──> Pipeline
                                              │
          ┌───────────────────────┬──────────┴───────────┐
          ▼                       ▼                        ▼
   input-handling          text-extraction          summarization
  (classify + validate)   .txt → read directly      Bedrock (or mock)
                          .jpg → Textract OCR
```

| Stage | Module | HTTP status on failure |
| --- | --- | --- |
| Input handling | `src/inputHandler.ts` | 400 |
| Text extraction | `src/textReader.ts`, `src/ocrExtractor.ts` | 422 |
| Summarization | `src/summarizer.ts` | 500 |

On success the endpoint returns `{ "summary": "..." }`; on failure it returns `{ "error": "...", "stage": "..." }`.

## Project structure

```
src/
  server.ts        HTTP server + multipart upload handling (entry point)
  pipeline.ts      Orchestrates the three stages
  inputHandler.ts  Classifies by extension, enforces size limits
  textReader.ts    Reads .txt bytes as text
  ocrExtractor.ts  Extracts text from JPEG via Amazon Textract
  summarizer.ts    Summarizer interface + Bedrock and mock implementations
  config.ts        Env-var configuration with POC defaults
  types.ts         Shared pipeline types
public/
  index.html       Single-page frontend
terraform/         Optional AWS deployment (Lambda Function URL)
.kiro/specs/       Requirements, design, and tasks for the feature
```

## Prerequisites

- Node.js 18 or newer
- AWS credentials configured (for the default Bedrock summarizer and for Textract when summarizing images). Textract and Bedrock must be available/enabled in your chosen region.

## Getting started

Install dependencies and build:

```bash
npm install
npm run build
```

Start the server:

```bash
npm start
```

Then open http://localhost:3000, choose a `.txt` or `.jpg`/`.jpeg` file, and submit.

### Scripts

| Script | Description |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm start` / `npm run serve` | Run the compiled server |

## Configuration

All configuration is read from environment variables with sensible POC defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `HTTP_PORT` (or `PORT`) | `3000` | Port the local server listens on |
| `MAX_INPUT_SIZE_BYTES` | `10485760` (10 MB) | Max upload size; valid range 1 byte–100 MB |
| `MAX_SUMMARIZER_INPUT_BYTES` | `100000` | Extracted text is truncated to this before summarizing |
| `SUMMARIZER_TIMEOUT_MS` | `30000` | Summarizer invocation timeout |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Foundation model used for summarization |
| `AWS_REGION` | `us-east-1` | Region for the Textract and Bedrock clients |

## Deployment (optional)

The `terraform/` directory deploys the app as a single Node.js 20 AWS Lambda fronted by a public [Lambda Function URL](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html) (no API Gateway), with an optional monthly budget guardrail.

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # adjust values as needed
terraform init
terraform apply
```

After apply, the `web_app_url` output is the public HTTPS URL of the app.

> **Note:** the Function URL uses `authorization_type = NONE`, so the deployed endpoint is publicly reachable. This keeps the POC simple — add authorization before using it for anything real.

## Notes

- Per the spec, automated tests are out of scope for this proof of concept, and the implementation favors simple, readable TypeScript.
- The feature's requirements, design, and tasks live under `.kiro/specs/text-summary-extractor/`.
