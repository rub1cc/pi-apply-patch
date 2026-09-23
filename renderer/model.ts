import type { AppliedFileChange, ParsedDiff } from "../types.ts";

export interface DiffModel {
  type: AppliedFileChange["type"];
  path: string;
  moveTo?: string;
  added: number;
  removed: number;
  diff: ParsedDiff;
}

export function getChangePath(change: DiffModel): string {
  return change.moveTo ? `${change.path} → ${change.moveTo}` : change.path;
}

export function getChangeLabel(change: DiffModel): string {
  const path = getChangePath(change);
  if (change.type === "add") return `Added ${path}`;
  if (change.type === "delete") return `Deleted ${path}`;
  return path;
}

export function getDiffLineCount(diff: ParsedDiff): number {
  return diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}
