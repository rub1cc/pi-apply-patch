import type { DiffHunk, DiffLine, ParsedDiff } from "../types.ts";

const HUNK_HEADER =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

/** Parse the stable unified-diff interchange format into renderer data. */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  const sourceLines = patch.replace(/\r\n/g, "\n").split("\n");
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;

  for (const sourceLine of sourceLines) {
    const header = HUNK_HEADER.exec(sourceLine);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }

    if (!current) continue;

    let line: DiffLine | undefined;
    switch (sourceLine[0]) {
      case " ":
        line = {
          type: "context",
          oldLine: oldLine++,
          newLine: newLine++,
          content: sourceLine.slice(1),
        };
        break;
      case "-":
        line = {
          type: "remove",
          oldLine: oldLine++,
          content: sourceLine.slice(1),
        };
        removed++;
        break;
      case "+":
        line = {
          type: "add",
          newLine: newLine++,
          content: sourceLine.slice(1),
        };
        added++;
        break;
      case "\\":
        if (sourceLine === "\\ No newline at end of file") {
          const previous = current.lines[current.lines.length - 1];
          if (previous) previous.noNewlineAtEnd = true;
        }
        break;
    }

    if (line) current.lines.push(line);
  }

  return { hunks, stats: { added, removed } };
}
