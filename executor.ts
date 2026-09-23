import path from "node:path";
import {
  readSnapshot,
  removeFile,
  removeFileIfPresent,
  resolvePatchPath,
  snapshotEquals,
  writeFileAtomic,
} from "./filesystem.ts";
import { parsePatch } from "./parser.ts";
import { createDiff } from "./renderer/diff.ts";
import type {
  AppliedFileChange,
  ApplyPatchResultData,
  PatchOperation,
  Snapshot,
  UpdateChunk,
  VirtualFile,
} from "./types.ts";

function rstrip(value: string): string {
  return value.replace(/[ \t]+$/g, "");
}

type MatchMode = "exact" | "rstrip" | "trim";

function lineMatches(actual: string, expected: string, mode: MatchMode): boolean {
  switch (mode) {
    case "exact":
      return actual === expected;
    case "rstrip":
      return rstrip(actual) === rstrip(expected);
    case "trim":
      return actual.trim() === expected.trim();
  }
}

function sequenceMatches(
  lines: string[],
  needle: string[],
  index: number,
  mode: MatchMode,
): boolean {
  if (index + needle.length > lines.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (!lineMatches(lines[index + i], needle[i], mode)) return false;
  }
  return true;
}

function findSequence(
  lines: string[],
  needle: string[],
  start: number,
  endOfFile = false,
): number {
  if (needle.length === 0) return endOfFile ? lines.length : start;

  const modes: MatchMode[] = ["exact", "rstrip", "trim"];
  for (const mode of modes) {
    if (endOfFile) {
      const index = lines.length - needle.length;
      if (index >= start && sequenceMatches(lines, needle, index, mode)) {
        return index;
      }
      continue;
    }

    for (
      let index = Math.max(0, start);
      index <= lines.length - needle.length;
      index++
    ) {
      if (sequenceMatches(lines, needle, index, mode)) return index;
    }
  }
  return -1;
}

function findContextLine(
  lines: string[],
  context: string,
  start: number,
): number {
  const modes: MatchMode[] = ["exact", "rstrip", "trim"];
  for (const mode of modes) {
    for (let i = Math.max(0, start); i < lines.length; i++) {
      if (lineMatches(lines[i], context, mode)) return i;
    }
  }
  return -1;
}

export function applyUpdateChunks(
  original: string,
  chunks: UpdateChunk[],
  filePath: string,
): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const normalized = original.replace(/\r\n/g, "\n");
  const originallyHadTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");

  if (originallyHadTrailingNewline && lines[lines.length - 1] === "") lines.pop();

  let cursor = 0;
  for (const chunk of chunks) {
    let searchStart = cursor;

    if (chunk.context !== undefined) {
      const contextIndex = findContextLine(lines, chunk.context, cursor);
      if (contextIndex < 0) {
        throw new Error(`Could not find context "${chunk.context}" in ${filePath}`);
      }
      searchStart = contextIndex + 1;
    }

    let position: number;
    if (chunk.oldLines.length === 0) {
      position = chunk.endOfFile ? lines.length : searchStart;
    } else {
      position = findSequence(
        lines,
        chunk.oldLines,
        searchStart,
        chunk.endOfFile,
      );
      if (position < 0) {
        const preview = chunk.oldLines.slice(0, 4).join("\n");
        throw new Error(
          `Could not apply patch to ${filePath}.\n` +
            `Expected context was not found:\n${preview}`,
        );
      }
    }

    lines.splice(position, chunk.oldLines.length, ...chunk.newLines);
    cursor = position + chunk.newLines.length;
  }

  let trailingNewline = originallyHadTrailingNewline;
  if (original.length === 0 && lines.length > 0) trailingNewline = true;

  let result = lines.join("\n") + (trailingNewline ? "\n" : "");
  if (eol === "\r\n") result = result.replace(/\n/g, "\r\n");
  return result;
}

function createChange(
  operation: PatchOperation,
  oldContent: string,
  newContent: string,
  moveTo?: string,
): AppliedFileChange {
  const diff = createDiff(oldContent, newContent);
  const base = {
    path: operation.path,
    oldContent,
    newContent,
    added: diff.stats.added,
    removed: diff.stats.removed,
    diff,
  };

  if (operation.type === "update" && moveTo) {
    return { ...base, type: "move", moveTo };
  }
  return { ...base, type: operation.type } as AppliedFileChange;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Patch application cancelled");
}

export async function applyPatch(
  root: string,
  patchText: string,
  signal?: AbortSignal,
): Promise<ApplyPatchResultData> {
  const operations = parsePatch(patchText);
  const initial = new Map<string, Snapshot>();
  const virtual = new Map<string, VirtualFile | null>();
  const claimedPaths = new Set<string>();
  const changes: AppliedFileChange[] = [];

  const load = async (absolutePath: string): Promise<VirtualFile | null> => {
    if (virtual.has(absolutePath)) return virtual.get(absolutePath)!;
    const snapshot = await readSnapshot(absolutePath);
    throwIfAborted(signal);
    initial.set(absolutePath, snapshot);
    const value = snapshot.exists
      ? { content: snapshot.content!, mode: snapshot.mode! }
      : null;
    virtual.set(absolutePath, value);
    return value;
  };

  const claim = (absolutePath: string, label: string) => {
    if (claimedPaths.has(absolutePath)) {
      throw new Error(`Path appears more than once in patch: ${label}`);
    }
    claimedPaths.add(absolutePath);
  };

  for (const operation of operations) {
    throwIfAborted(signal);
    const source = resolvePatchPath(root, operation.path);
    claim(source, operation.path);

    if (operation.type === "add") {
      if (await load(source)) {
        throw new Error(`Cannot add file because it already exists: ${operation.path}`);
      }
      virtual.set(source, { content: operation.content, mode: 0o666 });
      changes.push(createChange(operation, "", operation.content));
      continue;
    }

    if (operation.type === "delete") {
      const existing = await load(source);
      if (!existing) throw new Error(`Cannot delete missing file: ${operation.path}`);
      virtual.set(source, null);
      changes.push(createChange(operation, existing.content, ""));
      continue;
    }

    const existing = await load(source);
    if (!existing) throw new Error(`Cannot update missing file: ${operation.path}`);

    const updatedContent = applyUpdateChunks(
      existing.content,
      operation.chunks,
      operation.path,
    );
    const updatedFile = { content: updatedContent, mode: existing.mode };
    if (operation.moveTo) {
      const destination = resolvePatchPath(root, operation.moveTo);
      if (destination !== source) {
        claim(destination, operation.moveTo);
        if (await load(destination)) {
          throw new Error(`Cannot move to existing file: ${operation.moveTo}`);
        }
        changes.push(
          createChange(
            operation,
            existing.content,
            updatedContent,
            operation.moveTo,
          ),
        );
        virtual.set(source, null);
        virtual.set(destination, updatedFile);
        continue;
      }
    }

    changes.push(createChange(operation, existing.content, updatedContent));
    virtual.set(source, updatedFile);
  }

  for (const [filePath, snapshot] of initial) {
    throwIfAborted(signal);
    const current = await readSnapshot(filePath);
    if (!snapshotEquals(snapshot, current)) {
      throw new Error(
        `File changed while patch was being prepared: ${path.relative(root, filePath)}`,
      );
    }
  }

  const writes: Array<[string, VirtualFile]> = [];
  const deletes: string[] = [];
  for (const [filePath, finalState] of virtual) {
    const before = initial.get(filePath);
    if (!before) continue;
    if (finalState === null) {
      if (before.exists) deletes.push(filePath);
    } else if (!before.exists || before.content !== finalState.content) {
      writes.push([filePath, finalState]);
    }
  }

  try {
    for (const [filePath, file] of writes) {
      throwIfAborted(signal);
      await writeFileAtomic(filePath, file);
    }
    for (const filePath of deletes) {
      throwIfAborted(signal);
      await removeFile(filePath);
    }
  } catch (error) {
    for (const [filePath, snapshot] of initial) {
      try {
        if (snapshot.exists) {
          await writeFileAtomic(filePath, {
            content: snapshot.content!,
            mode: snapshot.mode!,
          });
        } else {
          await removeFileIfPresent(filePath);
        }
      } catch {
        // Preserve the original commit error.
      }
    }
    throw error;
  }

  const added = changes.reduce((total, change) => total + change.added, 0);
  const removed = changes.reduce((total, change) => total + change.removed, 0);
  return {
    details: {
      changes,
      stats: { files: changes.length, added, removed },
    },
  };
}
