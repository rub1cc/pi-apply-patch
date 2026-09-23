import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { ParsedDiff } from "../types.ts";
import { parseUnifiedDiff } from "./parse.ts";

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Build display data from actual before/after contents. The original patch
 * language is deliberately not involved in this stage.
 */
export function createDiff(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): ParsedDiff {
  const patch = generateUnifiedPatch(
    "file",
    normalizeContent(oldContent),
    normalizeContent(newContent),
    contextLines,
  );
  return parseUnifiedDiff(patch);
}
