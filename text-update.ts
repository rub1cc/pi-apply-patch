import type { UpdateChunk } from "./types.ts";

interface SourceLine {
  text: string;
  ending: string;
}

interface Replacement {
  start: number;
  oldLength: number;
  newLines: string[];
}

function parseSource(contents: string): {
  lines: SourceLine[];
  preferredEnding: string;
} {
  const lines: SourceLine[] = [];
  let preferredEnding: string | undefined;
  let start = 0;
  const endings = /\r\n|\r|\n/g;
  for (const match of contents.matchAll(endings)) {
    preferredEnding ??= match[0];
    lines.push({ text: contents.slice(start, match.index), ending: match[0] });
    start = match.index + match[0].length;
  }
  if (start < contents.length) {
    lines.push({ text: contents.slice(start), ending: "" });
  }
  return { lines, preferredEnding: preferredEnding ?? "\n" };
}

// Search the original lines, never lines inserted by an earlier chunk. The EOF
// marker anchors the search at the tail, as in Codex's seek_sequence.
function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number {
  if (pattern.length === 0) return start;
  const last = lines.length - pattern.length;
  const searchStart = eof ? Math.max(start, last) : start;
  const normalizers = [
    (text: string) => text,
    (text: string) => text.trimEnd(),
    (text: string) => text.trim(),
  ];
  for (const normalize of normalizers) {
    for (let index = searchStart; index <= last; index++) {
      if (pattern.every((text, offset) =>
        normalize(lines[index + offset]) === normalize(text)
      )) return index;
    }
  }
  return -1;
}

/** Apply Codex-style updates while retaining the bytes of unchanged lines. */
export function applyUpdateChunks(
  original: string,
  chunks: UpdateChunk[],
  filePath: string,
): string {
  // A move-only operation is not a text update (in particular, do not terminate
  // its final line). Treat a UTF-8 BOM as file metadata, not searchable content.
  if (chunks.length === 0) return original;
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const { lines, preferredEnding } = parseSource(original.slice(bom.length));
  const texts = lines.map((line) => line.text);
  const replacements: Replacement[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = seekSequence(texts, [chunk.context], cursor, false);
      if (contextIndex < 0) {
        throw new Error(`Could not find context "${chunk.context}" in ${filePath}`);
      }
      cursor = contextIndex + 1;
    }

    // Additions-only chunks append, even if they have a jump context. They do
    // not move the original-coordinate cursor; subsequent hunks still search
    // the original file. Stable sorting below keeps multiple appends ordered.
    if (chunk.oldLines.length === 0) {
      replacements.push({ start: lines.length, oldLength: 0, newLines: chunk.newLines });
      continue;
    }

    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let position = seekSequence(texts, pattern, cursor, chunk.endOfFile);
    if (position < 0 && pattern.at(-1) === "") {
      // Source lines store the terminator on the preceding line, not as an
      // extra empty element. Only discard this sentinel after a failed match:
      // a real blank final line must still participate in the update.
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      position = seekSequence(texts, pattern, cursor, chunk.endOfFile);
    }
    if (position < 0) {
      throw new Error(
        `Could not apply patch to ${filePath}.\n` +
        `Expected context was not found (hunks must not overlap):\n${chunk.oldLines.join("\n")}`,
      );
    }

    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices ?? []) {
      // The final empty context sentinel may have been stripped above.
      if (oldContext >= pattern.length || newContext >= newLines.length) break;
      if (!Number.isInteger(oldContext) || !Number.isInteger(newContext) ||
          oldContext < oldStart || newContext < newStart) {
        throw new Error(`Invalid context line indices in ${filePath}`);
      }
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push({
          start: position + oldStart,
          oldLength: oldContext - oldStart,
          newLines: newLines.slice(newStart, newContext),
        });
      }
      // Keep the source line itself, not the patch's potentially fuzzy text.
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newLines.length) {
      replacements.push({
        start: position + oldStart,
        oldLength: pattern.length - oldStart,
        newLines: newLines.slice(newStart),
      });
    }
    cursor = position + pattern.length;
  }

  replacements.sort((a, b) => a.start - b.start);
  const result: SourceLine[] = [];
  let sourceIndex = 0;
  for (const replacement of replacements) {
    if (replacement.start < sourceIndex ||
        replacement.start + replacement.oldLength > lines.length) {
      throw new Error(`Overlapping update hunks in ${filePath}`);
    }
    for (let index = sourceIndex; index < replacement.start; index++) {
      result.push(lines[index]);
    }
    for (const text of replacement.newLines) {
      result.push({ text, ending: preferredEnding });
    }
    sourceIndex = replacement.start + replacement.oldLength;
  }
  for (let index = sourceIndex; index < lines.length; index++) {
    result.push(lines[index]);
  }
  // Codex SourceFile terminates every resulting line, including an original
  // unterminated line moved inward by an append. Deleting every line is empty.
  if (result.length === 0) return "";
  return bom + result.map((line) => line.text + (line.ending || preferredEnding)).join("");
}
