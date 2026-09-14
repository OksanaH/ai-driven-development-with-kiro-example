# Requirements Document

## Introduction

The Text Summary Extractor is a proof-of-concept application that produces a concise summary from one of two input types: a plain text document, or a ZIP archive containing images that hold text. For text documents, the application uses Amazon Bedrock to generate the summary. For ZIP archives, the application first extracts text from each image using Amazon Textract (a cost-effective managed OCR service), aggregates the extracted text, then uses Amazon Bedrock to generate the summary. Because this is a proof of concept, automated tests are out of scope. Cost efficiency is an explicit design priority, so requirements favor selective service invocation, reasonable input-size limits, and avoidance of redundant AWS calls.

## Glossary

- **Application**: The text-summary-extractor proof-of-concept application that orchestrates input handling, text extraction, and summarization.
- **Input_Handler**: The Application component that identifies the input type and validates it before processing.
- **Text_Document**: A plain text input file (for example, a `.txt` file) supplied directly to the Application.
- **Image_Archive**: A ZIP archive supplied to the Application that contains one or more image files bearing text.
- **Image_File**: A single image (for example, `.png`, `.jpg`, or `.jpeg`) contained within an Image_Archive.
- **OCR_Service**: Amazon Textract, the managed AWS service used to extract text from Image_File contents.
- **Summarizer**: Amazon Bedrock, the managed AWS service used to generate a summary from extracted text.
- **Extracted_Text**: The text obtained either directly from a Text_Document or aggregated from all Image_File contents via the OCR_Service.
- **Summary**: The condensed text output produced by the Summarizer from the Extracted_Text.
- **Max_Input_Size**: The configured upper bound on total input size (document bytes or archive uncompressed bytes) that the Application accepts.
- **Max_Summarizer_Input**: The configurable upper bound, expressed in bytes, on the Extracted_Text length that the Application sends to the Summarizer in a single invocation.

## Requirements

### Requirement 1: Accept and Identify Input

**User Story:** As a user, I want to provide either a text document or a ZIP of images, so that the Application processes the correct input type without manual configuration.

#### Acceptance Criteria

1. WHEN a user provides an input file, THE Input_Handler SHALL classify the input as a Text_Document if its file extension is .txt, and as an Image_Archive if its file extension is .zip.
2. IF the provided input has a file extension other than .txt or .zip, THEN THE Input_Handler SHALL return a descriptive error identifying the detected extension and SHALL NOT perform any further processing.
3. IF the provided input path does not exist, THEN THE Input_Handler SHALL return an error indicating the input was not found and SHALL NOT perform any further processing.
4. IF the provided input path exists but cannot be read, THEN THE Input_Handler SHALL return an error indicating the input could not be accessed and SHALL NOT perform any further processing.
5. WHERE the input is an Image_Archive, THE Input_Handler SHALL enumerate the entries whose file extension is .png, .jpg, or .jpeg as Image_File entries.
6. IF an Image_Archive contains no entries with a .png, .jpg, or .jpeg extension, THEN THE Input_Handler SHALL return an error indicating the archive contains no supported images.

### Requirement 2: Enforce Input Size Limits for Cost Control

**User Story:** As a cost-conscious user, I want the Application to reject oversized inputs, so that AWS processing costs stay bounded.

#### Acceptance Criteria

1. THE Application SHALL define a Max_Input_Size value, expressed in bytes, that is configurable within the range of 1 byte to 104,857,600 bytes (100 MB) and defaults to 10,485,760 bytes (10 MB) when not otherwise configured.
2. IF a Text_Document has a byte size strictly greater than the Max_Input_Size, THEN THE Input_Handler SHALL reject the input before invoking the OCR_Service or the Summarizer and return an error indicating the input exceeded the size limit and stating the configured Max_Input_Size.
3. IF an Image_Archive has a total uncompressed byte size strictly greater than the Max_Input_Size, THEN THE Input_Handler SHALL reject the input before invoking the OCR_Service or the Summarizer and return an error indicating the input exceeded the size limit and stating the configured Max_Input_Size.
4. WHERE an Image_Archive contains entries whose file type is not a supported Image_File type, THE Input_Handler SHALL exclude those entries from OCR processing without invoking the OCR_Service for them and SHALL record the count and identity of each excluded entry for reporting.

### Requirement 3: Extract Text from a Text Document

**User Story:** As a user, I want the Application to read the text from my document directly, so that no unnecessary OCR cost is incurred for plain text.

#### Acceptance Criteria

1. WHEN the input is a Text_Document, THE Application SHALL read the document contents as the Extracted_Text without invoking the OCR_Service.
2. IF a Text_Document contains only whitespace characters or zero characters after being read, THEN THE Application SHALL return an error indicating the document is empty.
3. IF a Text_Document cannot be decoded as text, THEN THE Application SHALL return an error indicating the document could not be decoded.

### Requirement 4: Extract Text from Images via OCR

**User Story:** As a user, I want the Application to read text out of the images in my ZIP, so that image-based documents can be summarized.

#### Acceptance Criteria

1. WHEN the input is an Image_Archive, THE Application SHALL send each supported Image_File to the OCR_Service exactly once, retrying up to 2 additional times only on a transient OCR_Service error, and obtain its detected text.
2. WHEN detected text has been obtained for all supported Image_File entries, THE Application SHALL aggregate the detected text into a single Extracted_Text value by concatenating each Image_File's detected text in ascending order of the Image_File entry name within the Image_Archive.
3. IF the OCR_Service returns an error for an Image_File after all retry attempts are exhausted, THEN THE Application SHALL record the affected Image_File identity and the failure in a processing result that is reported to the user, and SHALL continue processing the remaining Image_File entries.
4. IF no supported Image_File in the Image_Archive yields detected text containing at least one non-whitespace character, THEN THE Application SHALL return an error indicating no text was extracted.
5. WHERE an Image_File was recorded as excluded during input handling, THE Application SHALL NOT invoke the OCR_Service for that Image_File.

### Requirement 5: Summarize Extracted Text

**User Story:** As a user, I want a concise summary of my document, so that I can understand its content quickly.

#### Acceptance Criteria

1. WHEN Extracted_Text contains at least one non-whitespace character, THE Application SHALL send the Extracted_Text to the Summarizer to generate a Summary.
2. IF Extracted_Text is empty or contains only whitespace, THEN THE Application SHALL NOT invoke the Summarizer and SHALL return an error indicating there is no text to summarize.
3. WHEN the Summarizer returns a result, THE Application SHALL present the Summary to the user.
4. IF the Summarizer returns an error or does not respond within a configurable timeout, THEN THE Application SHALL return a descriptive error indicating summarization failed and SHALL NOT output a Summary.
5. WHERE the Extracted_Text byte length exceeds the configurable Max_Summarizer_Input value, THE Application SHALL truncate the Extracted_Text to the Max_Summarizer_Input value before invoking the Summarizer.

### Requirement 6: Report Results and Failures

**User Story:** As a user, I want clear feedback about what was processed and what failed, so that I can trust and act on the output.

#### Acceptance Criteria

1. WHEN a Summary has been generated, THE Application SHALL output the Summary to the user before terminating.
2. WHERE one or more Image_File entries failed OCR or were excluded during input handling, THE Application SHALL output, alongside the Summary, both the total count of affected Image_File entries and the file name of each affected Image_File.
3. IF an unrecoverable error prevents a Summary from being generated, THEN THE Application SHALL output a single descriptive error message identifying the failed processing stage as one of input handling, text extraction, or summarization, and SHALL NOT output a Summary.
4. WHEN a Summary is generated after one or more Image_File entries failed OCR, THE Application SHALL output the Summary together with the affected Image_File report rather than treating the run as a failure.
