import type {
  AppliedFileChange,
  ApplyPatchDetails,
  DiffHunk,
  DiffLine,
  ParsedDiff,
} from "../types.ts";
import { parseUnifiedDiff } from "./parse.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function normalizeLine(value: unknown): DiffLine | undefined {
  if (!isRecord(value) || typeof value.content !== "string") return undefined;
  if (
    value.type !== "context" &&
    value.type !== "add" &&
    value.type !== "remove"
  ) {
    return undefined;
  }

  return {
    type: value.type,
    content: value.content,
    oldLine: typeof value.oldLine === "number" ? value.oldLine : undefined,
    newLine: typeof value.newLine === "number" ? value.newLine : undefined,
    noNewlineAtEnd:
      value.noNewlineAtEnd === true ? true : undefined,
  };
}

function normalizeHunk(value: unknown): DiffHunk | undefined {
  if (!isRecord(value) || !Array.isArray(value.lines)) return undefined;
  const lines = value.lines.map(normalizeLine);
  if (lines.some((line) => line === undefined)) return undefined;

  const fields = [value.oldStart, value.oldLines, value.newStart, value.newLines];
  if (fields.some((field) => typeof field !== "number")) return undefined;

  return {
    oldStart: value.oldStart as number,
    oldLines: value.oldLines as number,
    newStart: value.newStart as number,
    newLines: value.newLines as number,
    lines: lines as DiffLine[],
  };
}

function parseLegacyDisplayDiff(value: string): ParsedDiff | undefined {
  if (value.trim() === "") {
    return { hunks: [], stats: { added: 0, removed: 0 } };
  }

  const hunks: DiffHunk[] = [];
  let lines: DiffLine[] = [];

  const flush = () => {
    if (lines.length === 0) return;
    const firstNumber = lines[0].oldLine ?? lines[0].newLine ?? 1;
    hunks.push({
      oldStart: firstNumber,
      oldLines: lines.filter((line) => line.type !== "add").length,
      newStart: firstNumber,
      newLines: lines.filter((line) => line.type !== "remove").length,
      lines,
    });
    lines = [];
  };

  for (const sourceLine of value.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s+\.\.\.\s*$/.test(sourceLine)) {
      flush();
      continue;
    }

    const match = /^([ +\-])\s*(\d+)\s(.*)$/.exec(sourceLine);
    if (!match) return undefined;

    const number = Number(match[2]);
    const content = match[3];
    if (match[1] === "+") {
      lines.push({ type: "add", newLine: number, content });
    } else if (match[1] === "-") {
      lines.push({ type: "remove", oldLine: number, content });
    } else {
      lines.push({
        type: "context",
        oldLine: number,
        newLine: number,
        content,
      });
    }
  }
  flush();

  const allLines = hunks.flatMap((hunk) => hunk.lines);
  return {
    hunks,
    stats: {
      added: allLines.filter((line) => line.type === "add").length,
      removed: allLines.filter((line) => line.type === "remove").length,
    },
  };
}

function normalizeDiff(value: unknown): ParsedDiff | undefined {
  if (typeof value === "string") {
    return value.split(/\r?\n/).some((line) => line.startsWith("@@"))
      ? parseUnifiedDiff(value)
      : parseLegacyDisplayDiff(value);
  }
  if (!isRecord(value) || !Array.isArray(value.hunks)) return undefined;

  const hunks = value.hunks.map(normalizeHunk);
  if (hunks.some((hunk) => hunk === undefined)) return undefined;

  const parsedHunks = hunks as DiffHunk[];
  const calculatedAdded = parsedHunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.type === "add").length,
    0,
  );
  const calculatedRemoved = parsedHunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.type === "remove").length,
    0,
  );
  const stats = isRecord(value.stats) ? value.stats : {};

  return {
    hunks: parsedHunks,
    stats: {
      added: count(stats.added, calculatedAdded),
      removed: count(stats.removed, calculatedRemoved),
    },
  };
}

function normalizeChange(value: unknown): AppliedFileChange | undefined {
  if (!isRecord(value) || typeof value.path !== "string") return undefined;
  if (
    value.type !== "add" &&
    value.type !== "delete" &&
    value.type !== "update" &&
    value.type !== "move"
  ) {
    return undefined;
  }

  const diff = normalizeDiff(value.diff);
  if (!diff) return undefined;

  const moveTo = typeof value.moveTo === "string" ? value.moveTo : undefined;
  const type = value.type === "update" && moveTo ? "move" : value.type;
  if (type === "move" && !moveTo) return undefined;

  const base = {
    path: value.path,
    oldContent: typeof value.oldContent === "string" ? value.oldContent : "",
    newContent: typeof value.newContent === "string" ? value.newContent : "",
    added: count(value.added, diff.stats.added),
    removed: count(value.removed, diff.stats.removed),
    diff,
  };

  return type === "move"
    ? { ...base, type, moveTo }
    : { ...base, type } as AppliedFileChange;
}

/**
 * Convert persisted tool details to the current renderer model.
 *
 * Older sessions store top-level `added`/`removed` totals and numbered diff
 * strings, while current executions store `stats` and parsed diffs.
 */
export function normalizeApplyPatchDetails(
  value: unknown,
): ApplyPatchDetails | undefined {
  if (!isRecord(value) || !Array.isArray(value.changes)) return undefined;

  const changes = value.changes.map(normalizeChange);
  if (changes.some((change) => change === undefined)) return undefined;

  const normalizedChanges = changes as AppliedFileChange[];
  const calculatedAdded = normalizedChanges.reduce(
    (total, change) => total + change.added,
    0,
  );
  const calculatedRemoved = normalizedChanges.reduce(
    (total, change) => total + change.removed,
    0,
  );
  const stats = isRecord(value.stats) ? value.stats : {};

  return {
    changes: normalizedChanges,
    stats: {
      files: normalizedChanges.length,
      added: count(stats.added, count(value.added, calculatedAdded)),
      removed: count(stats.removed, count(value.removed, calculatedRemoved)),
    },
  };
}
