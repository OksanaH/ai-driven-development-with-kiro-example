# Requirements Document

## Introduction

The Text Summary Extractor is a proof-of-concept web application that produces a concise summary from a single uploaded file. Through a simple browser-based frontend, a user uploads one file that is either a plain text file (`.txt`) or a single JPEG image (`.jpg`/`.jpeg`), submits it, and sees the resulting summary (or a descriptive error) displayed in the browser. For text files, the Application reads the text directly. For JPEG images, the Application first extracts text using Amazon Textract (a cost-effective managed OCR service), then generates the summary. Summarization is performed by Amazon Bedrock through a Summarizer that is kept behind an interface; a local mock implementation is retained for offline runs and tests. The Application runs locally as an HTTP web server that serves the frontend and an upload endpoint. Because this is a proof of concept, automated tests are out of scope, and the implementation favors simple, readable TypeScript. Cost efficiency remains an explicit priority, so requirements favor selective service invocation, reasonable input-size limits, and avoidance of redundant AWS calls.

## Glossary

- **Application**: The text-summary-extractor proof-of-concept application that orchestrates the web server, input handling, text extraction, and summarization.
- **Web_Server**: The Application component that runs locally, serves the Web_Frontend, and exposes the Upload_Endpoint over HTTP.
- **Web_Frontend**: The browser-based user interface that provides a single-file upload control and a submit action, and that displays the Summary or an error.
- **Upload_Endpoint**: The HTTP endpoint exposed by the Web_Server that receives the Uploaded_File and returns either the Summary or an error to the Web_Frontend.
- **Uploaded_File**: The single file submitted by a user through the Web_Frontend for processing.
- **Input_Handler**: The Application component that classifies the Uploaded_File by extension and validates it before processing.
- **Text_Document**: An Uploaded_File whose file extension is `.txt`, supplied directly to the Application.
- **Image_File**: An Uploaded_File whose file extension is `.jpg` or `.jpeg`, holding text to be extracted.
- **OCR_Service**: Amazon Textract, the managed AWS service used to extract text from Image_File contents.
- **Summarizer**: The component used to generate a Summary from Extracted_Text, implemented behind an interface. The default implementation calls Amazon Bedrock; a local mock implementation is retained for offline runs and tests.
- **Extracted_Text**: The text obtained either directly from a Text_Document or from the Image_File via the OCR_Service.
- **Summary**: The condensed text output produced by the Summarizer from the Extracted_Text.
- **Max_Input_Size**: The configured upper bound, expressed in bytes, on the size of a single Uploaded_File that the Application accepts.
- **Max_Summarizer_Input**: The configurable upper bound, expressed in bytes, on the Extracted_Text length that the Application sends to the Summarizer in a single invocation.

## Requirements

### Requirement 1: Accept and Identify an Uploaded File

**User Story:** As a user, I want to upload a single text file or JPEG image through a browser, so that the Application processes the correct input type without manual configuration.

#### Acceptance Criteria

1. WHEN a user submits an Uploaded_File through the Web_Frontend, THE Input_Handler SHALL classify the Uploaded_File as a Text_Document if its file extension is `.txt`, and as an Image_File if its file extension is `.jpg` or `.jpeg`.
2. IF the Uploaded_File has a file extension other than `.txt`, `.jpg`, or `.jpeg`, THEN THE Input_Handler SHALL return a descriptive error identifying the detected extension and SHALL NOT perform any further processing.
3. IF no file is included in the submission, THEN THE Input_Handler SHALL return an error indicating that a file is required and SHALL NOT perform any further processing.
4. IF the Uploaded_File is received but its contents cannot be read, THEN THE Input_Handler SHALL return an error indicating the Uploaded_File could not be accessed and SHALL NOT perform any further processing.

### Requirement 2: Enforce Input Size Limits for Cost Control

**User Story:** As a cost-conscious user, I want the Application to reject an oversized upload, so that AWS processing costs stay bounded.

#### Acceptance Criteria

1. THE Application SHALL define a Max_Input_Size value, expressed in bytes, that is configurable within the range of 1 byte to 104,857,600 bytes (100 MB) and defaults to 10,485,760 bytes (10 MB) when not otherwise configured.
2. IF a Text_Document has a byte size strictly greater than the Max_Input_Size, THEN THE Input_Handler SHALL reject the Uploaded_File before invoking the OCR_Service or the Summarizer and return an error indicating the input exceeded the size limit and stating the configured Max_Input_Size.
3. IF an Image_File has a byte size strictly greater than the Max_Input_Size, THEN THE Input_Handler SHALL reject the Uploaded_File before invoking the OCR_Service or the Summarizer and return an error indicating the input exceeded the size limit and stating the configured Max_Input_Size.

### Requirement 3: Extract Text from a Text Document

**User Story:** As a user, I want the Application to read the text from my document directly, so that no unnecessary OCR cost is incurred for plain text.

#### Acceptance Criteria

1. WHEN the Uploaded_File is a Text_Document, THE Application SHALL read the document contents as the Extracted_Text without invoking the OCR_Service.
2. IF a Text_Document contains only whitespace characters or zero characters after being read, THEN THE Application SHALL return an error indicating the document is empty.
3. IF a Text_Document cannot be decoded as text, THEN THE Application SHALL return an error indicating the document could not be decoded.

### Requirement 4: Extract Text from a JPEG Image via OCR

**User Story:** As a user, I want the Application to read text out of my JPEG image, so that image-based documents can be summarized.

#### Acceptance Criteria

1. WHEN the Uploaded_File is an Image_File, THE Application SHALL send the Image_File to the OCR_Service exactly once, retrying up to 2 additional times only on a transient OCR_Service error, and obtain its detected text as the Extracted_Text.
2. IF the OCR_Service returns an error for the Image_File after all retry attempts are exhausted, THEN THE Application SHALL return a descriptive error indicating text extraction failed and SHALL NOT invoke the Summarizer.
3. IF the detected text for the Image_File contains no non-whitespace character, THEN THE Application SHALL return an error indicating no text was extracted.

### Requirement 5: Summarize Extracted Text

**User Story:** As a user, I want a concise summary of my document, so that I can understand its content quickly.

#### Acceptance Criteria

1. WHEN Extracted_Text contains at least one non-whitespace character, THE Application SHALL send the Extracted_Text to the Summarizer to generate a Summary.
2. IF Extracted_Text is empty or contains only whitespace, THEN THE Application SHALL NOT invoke the Summarizer and SHALL return an error indicating there is no text to summarize.
3. THE Summarizer SHALL be implemented behind an interface such that the Amazon Bedrock implementation and the local mock implementation are interchangeable without changing the Application components that invoke the Summarizer.
4. WHEN the Bedrock Summarizer is invoked, THE Summarizer SHALL call Amazon Bedrock's `InvokeModel` with the configured foundation model using the Anthropic Claude Messages API and SHALL return the model-generated Summary; WHEN the mock Summarizer is invoked, THE Summarizer SHALL produce a deterministic placeholder Summary derived from the Extracted_Text without invoking any external AWS service.
5. IF the Summarizer returns an error or does not respond within a configurable timeout, THEN THE Application SHALL return a descriptive error indicating summarization failed and SHALL NOT output a Summary.
6. WHERE the Extracted_Text byte length exceeds the configurable Max_Summarizer_Input value, THE Application SHALL truncate the Extracted_Text to the Max_Summarizer_Input value before invoking the Summarizer.

### Requirement 6: Serve the Web Frontend and Report Results

**User Story:** As a user, I want to run the Application locally and see the summary or a clear error in my browser, so that I can trust and act on the output.

#### Acceptance Criteria

1. WHEN the Application is started locally, THE Web_Server SHALL listen on a configurable HTTP port and serve the Web_Frontend containing a single-file upload control and a submit action.
2. WHEN a user submits an Uploaded_File through the Web_Frontend, THE Web_Frontend SHALL send the Uploaded_File to the Upload_Endpoint.
3. WHEN processing of the Uploaded_File succeeds, THE Upload_Endpoint SHALL return the Summary to the Web_Frontend, and THE Web_Frontend SHALL display the Summary.
4. IF an unrecoverable error prevents a Summary from being generated, THEN THE Upload_Endpoint SHALL return a single descriptive error message identifying the failed processing stage as one of input handling, text extraction, or summarization, and THE Web_Frontend SHALL display that error message and SHALL NOT display a Summary.
