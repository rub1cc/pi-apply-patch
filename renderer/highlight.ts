import type { DiffLine } from "../types.ts";
import { createInlineDiff, type InlineSpan } from "./inline-diff.ts";

export function createInlineHighlightMap(
  lines: DiffLine[],
): Map<DiffLine, InlineSpan[]> {
  const result = new Map<DiffLine, InlineSpan[]>();
  let index = 0;

  while (index < lines.length) {
    if (lines[index].type !== "remove") {
      index++;
      continue;
    }

    const removedStart = index;
    while (index < lines.length && lines[index].type === "remove") index++;
    const addedStart = index;
    while (index < lines.length && lines[index].type === "add") index++;

    const removedCount = addedStart - removedStart;
    const addedCount = index - addedStart;
    const paired = Math.min(removedCount, addedCount);

    for (let offset = 0; offset < paired; offset++) {
      const removedLine = lines[removedStart + offset];
      const addedLine = lines[addedStart + offset];
      const spans = createInlineDiff(removedLine.content, addedLine.content);
      result.set(removedLine, spans.oldSpans);
      result.set(addedLine, spans.newSpans);
    }
  }

  return result;
}
