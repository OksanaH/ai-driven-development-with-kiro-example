/**
 * Result reporting for the Text Summary Extractor pipeline.
 *
 * The reporter is the single place that writes the final outcome to the user
 * for the optional CLI entry point. On success it prints the summary to
 * stdout. On failure it prints one stage-tagged message to stderr and no
 * summary.
 */

import { ProcessingResult } from "./types";

/**
 * Render the final pipeline result to stdout/stderr.
 *
 * - Success: print the summary to stdout.
 * - Failure: print a single descriptive message tagged with the failed stage
 *   to stderr and print no summary.
 */
export function report(result: ProcessingResult): void {
  if (result.ok) {
    console.log(result.summary);
    return;
  }

  console.error(`[${result.error.stage}] ${result.error.message}`);
}
