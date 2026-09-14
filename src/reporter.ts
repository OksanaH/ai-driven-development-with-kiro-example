/**
 * Result reporting for the Text Summary Extractor pipeline.
 *
 * The reporter is the single place that writes the final outcome to the user.
 * On success it prints the summary and, when images were excluded or failed
 * OCR, an affected-image report alongside it. On failure it prints one
 * stage-tagged message and no summary.
 */

import { ProcessingResult } from "./types";

/**
 * Render the final pipeline result to stdout/stderr.
 *
 * - Success (6.1): print the summary.
 * - Success with affected images (6.2, 6.4): also print the total count and
 *   each affected file name; the run is still a success.
 * - Failure (6.3): print a single descriptive message tagged with the failed
 *   stage and print no summary.
 */
export function report(result: ProcessingResult): void {
  if (result.ok) {
    console.log(result.summary);

    if (result.affectedImages.length > 0) {
      console.log(`\nAffected images: ${result.affectedImages.length}`);
      for (const name of result.affectedImages) {
        console.log(`  - ${name}`);
      }
    }
    return;
  }

  console.error(`[${result.error.stage}] ${result.error.message}`);
}
