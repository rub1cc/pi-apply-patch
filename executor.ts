import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  assertPinnedPath,
  readSnapshot,
  removeFile,
  removeFileIfPresent,
  resolvePatchPath,
  snapshotEquals,
  writeFileAtomic,
} from "./filesystem.ts";
import { parsePatch } from "./parser.ts";
import { applyUpdateChunks } from "./text-update.ts";
export { applyUpdateChunks } from "./text-update.ts";
import { createDiff } from "./renderer/diff.ts";
import type {
  AppliedFileChange,
  ApplyPatchResultData,
  PatchOperation,
  Snapshot,
  VirtualFile,
} from "./types.ts";

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
  throwIfAborted(signal);
  // Resolve once so the paths we mutate are exactly the paths we lock.
  const operations = parsePatch(patchText).map((operation) => ({
    operation,
    source: resolvePatchPath(root, operation.path),
    destination: operation.type === "update" && operation.moveTo
      ? resolvePatchPath(root, operation.moveTo)
      : undefined,
  }));
  const paths = [...new Set(
    operations.flatMap(({ source, destination }) =>
      destination ? [source, destination] : [source],
    ),
  )].sort();

  // A stable order prevents overlapping multi-file patches from deadlocking.
  // Hold every lock through snapshots, validation, commit, and rollback.
  const acquire = (index: number): Promise<ApplyPatchResultData> => {
    throwIfAborted(signal);
    return index === paths.length
      ? applyLockedPatch(operations, root, signal)
      : withFileMutationQueue(paths[index]!, () => acquire(index + 1));
  };
  return acquire(0);
}

async function applyLockedPatch(
  operations: Array<{
    operation: PatchOperation;
    source: string;
    destination?: string;
  }>,
  root: string,
  signal?: AbortSignal,
): Promise<ApplyPatchResultData> {
  // Queue waits can outlive the path approval. Reject redirected ancestors
  // before taking snapshots, not just before the eventual commit.
  for (const { source, destination } of operations) {
    assertPinnedPath(source);
    if (destination) assertPinnedPath(destination);
  }
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

  for (const { operation, source, destination } of operations) {
    throwIfAborted(signal);
    claim(source, operation.path);

    if (operation.type === "add") {
      if (await load(source)) {
        throw new Error(`Cannot add file because it already exists: ${operation.path}`);
      }
      virtual.set(source, {
        content: operation.content,
        mode: 0o666 & ~process.umask(),
      });
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
    if (operation.moveTo && destination) {
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

  const attempted = new Set<string>();
  try {
    for (const [filePath, file] of writes) {
      throwIfAborted(signal);
      assertPinnedPath(filePath);
      attempted.add(filePath);
      await writeFileAtomic(filePath, file);
    }
    for (const filePath of deletes) {
      throwIfAborted(signal);
      assertPinnedPath(filePath);
      attempted.add(filePath);
      await removeFile(filePath);
    }
  } catch (error) {
    const rollbackFailures: Array<{ path: string; reason: string }> = [];
    for (const filePath of [...attempted].reverse()) {
      const snapshot = initial.get(filePath)!;
      try {
        if (snapshot.exists) {
          await writeFileAtomic(filePath, {
            content: snapshot.content!,
            mode: snapshot.mode!,
          });
        } else {
          await removeFileIfPresent(filePath);
        }
      } catch (rollbackError) {
        rollbackFailures.push({
          path: filePath,
          reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
    }
    if (rollbackFailures.length) {
      throw new PatchRollbackError(error, [...attempted], rollbackFailures);
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

/** Exposes potentially modified paths when best-effort restoration failed. */
export class PatchRollbackError extends Error {
  constructor(
    cause: unknown,
    readonly attemptedPaths: string[],
    readonly rollbackFailures: Array<{ path: string; reason: string }>,
  ) {
    super(
      `Patch commit failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
      `Rollback incomplete; files may remain changed: ${rollbackFailures.map(
        (failure) => `${failure.path} (${failure.reason})`,
      ).join("; ")}`,
      { cause },
    );
    this.name = "PatchRollbackError";
  }
}
