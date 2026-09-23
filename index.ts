import {
  generateDiffString,
  renderDiff,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { promises as fs } from "node:fs";
import path from "node:path";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

interface UpdateChunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

type PatchOperation =
  | {
      type: "add";
      path: string;
      content: string;
    }
  | {
      type: "delete";
      path: string;
    }
  | {
      type: "update";
      path: string;
      moveTo?: string;
      chunks: UpdateChunk[];
    };

interface VirtualFile {
  content: string;
  mode: number;
}

interface Snapshot {
  exists: boolean;
  content?: string;
  mode?: number;
}

interface ApplyPatchChange {
  type: "add" | "delete" | "update";
  path: string;
  moveTo?: string;
  added: number;
  removed: number;
  diff: string;
}

interface ApplyPatchDetails {
  changes: ApplyPatchChange[];
  added: number;
  removed: number;
}

interface ApplyPatchResultData {
  summaries: string[];
  details: ApplyPatchDetails;
}

interface ApplyPatchRenderState {
  callComponent?: Box;
}

const COLLAPSED_PREVIEW_LINES = 3;

function normalizePatch(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function isOperationHeader(line: string): boolean {
  return (
    line.startsWith(ADD_FILE) ||
    line.startsWith(DELETE_FILE) ||
    line.startsWith(UPDATE_FILE) ||
    line.trim() === END_PATCH
  );
}

function parsePatch(text: string): PatchOperation[] {
  const lines = normalizePatch(text).split("\n");

  let start = 0;
  while (start < lines.length && lines[start].trim() === "") {
    start++;
  }

  if (lines[start]?.trim() !== BEGIN_PATCH) {
    throw new Error(`Patch must start with "${BEGIN_PATCH}"`);
  }

  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") {
    end--;
  }

  if (lines[end]?.trim() !== END_PATCH) {
    throw new Error(`Patch must end with "${END_PATCH}"`);
  }

  const operations: PatchOperation[] = [];
  let i = start + 1;

  while (i < end) {
    const line = lines[i];

    // Allow blank separators between file operations.
    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith(ADD_FILE)) {
      const filePath = line.slice(ADD_FILE.length).trim();

      if (!filePath) {
        throw new Error("Add File requires a path");
      }

      i++;

      const content: string[] = [];

      while (i < end && !isOperationHeader(lines[i])) {
        const current = lines[i];

        if (!current.startsWith("+")) {
          throw new Error(
            `Invalid Add File line for "${filePath}": every line must start with "+"`,
          );
        }

        content.push(current.slice(1));
        i++;
      }

      operations.push({
        type: "add",
        path: filePath,
        // Codex apply_patch represents added files as newline-terminated text.
        content: content.join("\n") + "\n",
      });

      continue;
    }

    if (line.startsWith(DELETE_FILE)) {
      const filePath = line.slice(DELETE_FILE.length).trim();

      if (!filePath) {
        throw new Error("Delete File requires a path");
      }

      operations.push({
        type: "delete",
        path: filePath,
      });

      i++;
      continue;
    }

    if (line.startsWith(UPDATE_FILE)) {
      const filePath = line.slice(UPDATE_FILE.length).trim();

      if (!filePath) {
        throw new Error("Update File requires a path");
      }

      i++;

      let moveTo: string | undefined;

      if (lines[i]?.startsWith(MOVE_TO)) {
        moveTo = lines[i].slice(MOVE_TO.length).trim();

        if (!moveTo) {
          throw new Error("Move to requires a path");
        }

        i++;
      }

      const chunks: UpdateChunk[] = [];
      let currentChunk: UpdateChunk | undefined;

      const flushChunk = () => {
        if (!currentChunk) return;

        if (
          currentChunk.oldLines.length > 0 ||
          currentChunk.newLines.length > 0 ||
          currentChunk.context !== undefined ||
          currentChunk.endOfFile
        ) {
          chunks.push(currentChunk);
        }

        currentChunk = undefined;
      };

      while (i < end && !isOperationHeader(lines[i])) {
        const current = lines[i];

        if (current === "@@" || current.startsWith("@@ ")) {
          flushChunk();

          currentChunk = {
            context: current === "@@" ? undefined : current.slice(3),
            oldLines: [],
            newLines: [],
            endOfFile: false,
          };

          i++;
          continue;
        }

        if (current.trim() === END_OF_FILE) {
          if (!currentChunk) {
            currentChunk = {
              oldLines: [],
              newLines: [],
              endOfFile: true,
            };
          } else {
            currentChunk.endOfFile = true;
          }

          i++;
          continue;
        }

        if (
          current.startsWith(" ") ||
          current.startsWith("+") ||
          current.startsWith("-")
        ) {
          if (!currentChunk) {
            currentChunk = {
              oldLines: [],
              newLines: [],
              endOfFile: false,
            };
          }

          const prefix = current[0];
          const value = current.slice(1);

          switch (prefix) {
            case " ":
              currentChunk.oldLines.push(value);
              currentChunk.newLines.push(value);
              break;

            case "-":
              currentChunk.oldLines.push(value);
              break;

            case "+":
              currentChunk.newLines.push(value);
              break;
          }

          i++;
          continue;
        }

        throw new Error(
          `Invalid patch line while updating "${filePath}": ${current}`,
        );
      }

      flushChunk();

      if (chunks.length === 0 && !moveTo) {
        throw new Error(`Update File "${filePath}" contains no changes`);
      }

      operations.push({
        type: "update",
        path: filePath,
        moveTo,
        chunks,
      });

      continue;
    }

    throw new Error(`Unexpected patch line: ${line}`);
  }

  if (operations.length === 0) {
    throw new Error("Patch contains no file operations");
  }

  return operations;
}

function resolvePatchPath(root: string, filePath: string): string {
  if (filePath.includes("\0")) {
    throw new Error("File path contains a null byte");
  }

  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(root, filePath);

  const relative = path.relative(root, resolved);

  if (
    relative === "" ||
    relative === "." ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes the working directory: ${filePath}`);
  }

  return resolved;
}

function rstrip(value: string): string {
  return value.replace(/[ \t]+$/g, "");
}

type MatchMode = "exact" | "rstrip" | "trim";

function lineMatches(
  actual: string,
  expected: string,
  mode: MatchMode,
): boolean {
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
  if (index + needle.length > lines.length) {
    return false;
  }

  for (let i = 0; i < needle.length; i++) {
    if (!lineMatches(lines[index + i], needle[i], mode)) {
      return false;
    }
  }

  return true;
}

function findSequence(
  lines: string[],
  needle: string[],
  start: number,
  endOfFile = false,
): number {
  if (needle.length === 0) {
    return endOfFile ? lines.length : start;
  }

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
      if (sequenceMatches(lines, needle, index, mode)) {
        return index;
      }
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
      if (lineMatches(lines[i], context, mode)) {
        return i;
      }
    }
  }

  return -1;
}

function applyUpdateChunks(
  original: string,
  chunks: UpdateChunk[],
  filePath: string,
): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const normalized = original.replace(/\r\n/g, "\n");

  const originallyHadTrailingNewline = normalized.endsWith("\n");

  const lines = normalized.length === 0 ? [] : normalized.split("\n");

  if (originallyHadTrailingNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let cursor = 0;

  for (const chunk of chunks) {
    let searchStart = cursor;

    if (chunk.context !== undefined) {
      const contextIndex = findContextLine(lines, chunk.context, cursor);

      if (contextIndex < 0) {
        throw new Error(
          `Could not find context "${chunk.context}" in ${filePath}`,
        );
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

  // Adding lines to an empty file should produce a normal
  // newline-terminated text file.
  if (original.length === 0 && lines.length > 0) {
    trailingNewline = true;
  }

  let result = lines.join("\n") + (trailingNewline ? "\n" : "");

  if (eol === "\r\n") {
    result = result.replace(/\n/g, "\r\n");
  }

  return result;
}

async function readSnapshot(filePath: string): Promise<Snapshot> {
  try {
    const stat = await fs.lstat(filePath);

    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${filePath}`);
    }

    const buffer = await fs.readFile(filePath);

    let content: string;

    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
      }).decode(buffer);
    } catch {
      throw new Error(`Cannot patch non-UTF-8 file: ${filePath}`);
    }

    return {
      exists: true,
      content,
      mode: stat.mode,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
      };
    }

    throw error;
  }
}

function snapshotEquals(a: Snapshot, b: Snapshot): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;

  return a.content === b.content && (a.mode! & 0o777) === (b.mode! & 0o777);
}

async function writeFileAtomic(
  filePath: string,
  file: VirtualFile,
): Promise<void> {
  const dir = path.dirname(filePath);

  await fs.mkdir(dir, {
    recursive: true,
  });

  const temporaryPath = path.join(
    dir,
    `.${path.basename(filePath)}.pi-apply-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );

  try {
    await fs.writeFile(temporaryPath, file.content, {
      mode: file.mode & 0o777,
    });

    await fs.chmod(temporaryPath, file.mode & 0o777);

    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs
      .rm(temporaryPath, {
        force: true,
      })
      .catch(() => {});
  }
}

function normalizeContentForDiff(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countDisplayDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) {
      added++;
    } else if (line.startsWith("-")) {
      removed++;
    }
  }

  return { added, removed };
}

function createChangeDetail(
  type: ApplyPatchChange["type"],
  filePath: string,
  moveTo: string | undefined,
  oldContent: string,
  newContent: string,
): ApplyPatchChange {
  const { diff } = generateDiffString(
    normalizeContentForDiff(oldContent),
    normalizeContentForDiff(newContent),
  );
  const { added, removed } = countDisplayDiff(diff);

  return {
    type,
    path: filePath,
    moveTo: moveTo && moveTo !== filePath ? moveTo : undefined,
    added,
    removed,
    diff,
  };
}

function changePathLabel(change: ApplyPatchChange): string {
  return change.moveTo ? `${change.path} → ${change.moveTo}` : change.path;
}

function changeVerb(change: ApplyPatchChange): "Added" | "Deleted" | "Edited" {
  if (change.type === "add") return "Added";
  if (change.type === "delete") return "Deleted";
  return "Edited";
}

function formatCountSummary(
  added: number,
  removed: number,
  theme: Theme,
): string {
  return [
    theme.fg("muted", "("),
    theme.fg("toolDiffAdded", `+${added}`),
    theme.fg("muted", " "),
    theme.fg("toolDiffRemoved", `-${removed}`),
    theme.fg("muted", ")"),
  ].join("");
}

function indentAnsiLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function renderChangeDiff(
  change: ApplyPatchChange,
  expanded: boolean,
  theme: Theme,
): string {
  if (!change.diff.trim()) {
    return theme.fg("muted", "    (renamed without content changes)");
  }

  const rendered = renderDiff(change.diff, {
    filePath: change.moveTo ?? change.path,
  });
  const lines = rendered.split("\n");

  if (expanded || lines.length <= COLLAPSED_PREVIEW_LINES) {
    return indentAnsiLines(rendered, "    ");
  }

  return [
    ...lines.slice(0, COLLAPSED_PREVIEW_LINES).map((line) => `    ${line}`),
    theme.fg(
      "muted",
      `    … ${lines.length - COLLAPSED_PREVIEW_LINES} more line${
        lines.length - COLLAPSED_PREVIEW_LINES === 1 ? "" : "s"
      }`,
    ),
  ].join("\n");
}

function renderRichDiff(
  details: ApplyPatchDetails,
  expanded: boolean,
  theme: Theme,
): string {
  const { changes } = details;

  if (changes.length === 0) {
    return theme.fg("success", "• Patch applied");
  }

  const lines: string[] = [];

  if (changes.length === 1) {
    const change = changes[0];
    lines.push(
      [
        theme.fg("muted", "• "),
        theme.bold(changeVerb(change)),
        " ",
        changePathLabel(change),
        " ",
        formatCountSummary(change.added, change.removed, theme),
      ].join(""),
    );
    lines.push(renderChangeDiff(change, expanded, theme));
    return lines.join("\n");
  }

  lines.push(
    [
      theme.fg("muted", "• "),
      theme.bold("Edited"),
      ` ${changes.length} files `,
      formatCountSummary(details.added, details.removed, theme),
    ].join(""),
  );

  changes.forEach((change, index) => {
    if (index > 0) lines.push("");

    lines.push(
      [
        theme.fg("muted", "  └ "),
        changePathLabel(change),
        " ",
        formatCountSummary(change.added, change.removed, theme),
      ].join(""),
    );
    lines.push(renderChangeDiff(change, expanded, theme));
  });

  return lines.join("\n");
}

function getCallComponent(
  state: ApplyPatchRenderState,
  lastComponent: unknown,
): Box {
  if (lastComponent instanceof Box) {
    state.callComponent = lastComponent;
    return lastComponent;
  }

  if (state.callComponent) {
    return state.callComponent;
  }

  const component = new Box(1, 1, (text: string) => text);
  state.callComponent = component;
  return component;
}

function renderPendingCall(component: Box, theme: Theme): Box {
  component.setBgFn((text: string) => theme.bg("toolPendingBg", text));
  component.clear();
  component.addChild(
    new Text(theme.fg("toolTitle", theme.bold("apply_patch")), 0, 0),
  );
  return component;
}

function renderSettledCall(
  component: Box,
  details: ApplyPatchDetails | undefined,
  expanded: boolean,
  theme: Theme,
  isError: boolean,
  errorText?: string,
): Box {
  component.setBgFn((text: string) =>
    theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text),
  );
  component.clear();

  if (isError) {
    component.addChild(
      new Text(
        `${theme.fg("error", "✘ Failed to apply patch")}${
          errorText ? `\n${theme.fg("muted", errorText)}` : ""
        }`,
        0,
        0,
      ),
    );
    return component;
  }

  if (!details) {
    component.addChild(new Text(theme.fg("success", "• Patch applied"), 0, 0));
    return component;
  }

  component.addChild(new Text(renderRichDiff(details, expanded, theme), 0, 0));
  return component;
}

async function applyPatch(
  root: string,
  patchText: string,
): Promise<ApplyPatchResultData> {
  const operations = parsePatch(patchText);

  const initial = new Map<string, Snapshot>();
  const virtual = new Map<string, VirtualFile | null>();

  const claimedPaths = new Set<string>();
  const summaries: string[] = [];
  const changes: ApplyPatchChange[] = [];

  const load = async (absolutePath: string): Promise<VirtualFile | null> => {
    if (virtual.has(absolutePath)) {
      return virtual.get(absolutePath)!;
    }

    const snapshot = await readSnapshot(absolutePath);

    initial.set(absolutePath, snapshot);

    const value: VirtualFile | null = snapshot.exists
      ? {
          content: snapshot.content!,
          mode: snapshot.mode!,
        }
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
    const source = resolvePatchPath(root, operation.path);

    claim(source, operation.path);

    if (operation.type === "add") {
      const existing = await load(source);

      if (existing) {
        throw new Error(
          `Cannot add file because it already exists: ${operation.path}`,
        );
      }

      virtual.set(source, {
        content: operation.content,
        mode: 0o666,
      });

      changes.push(
        createChangeDetail(
          "add",
          operation.path,
          undefined,
          "",
          operation.content,
        ),
      );
      summaries.push(`Added ${operation.path}`);

      continue;
    }

    if (operation.type === "delete") {
      const existing = await load(source);

      if (!existing) {
        throw new Error(`Cannot delete missing file: ${operation.path}`);
      }

      virtual.set(source, null);

      changes.push(
        createChangeDetail(
          "delete",
          operation.path,
          undefined,
          existing.content,
          "",
        ),
      );
      summaries.push(`Deleted ${operation.path}`);

      continue;
    }

    const existing = await load(source);

    if (!existing) {
      throw new Error(`Cannot update missing file: ${operation.path}`);
    }

    const updatedContent = applyUpdateChunks(
      existing.content,
      operation.chunks,
      operation.path,
    );

    const updatedFile: VirtualFile = {
      content: updatedContent,
      mode: existing.mode,
    };

    changes.push(
      createChangeDetail(
        "update",
        operation.path,
        operation.moveTo,
        existing.content,
        updatedContent,
      ),
    );

    if (operation.moveTo) {
      const destination = resolvePatchPath(root, operation.moveTo);

      if (destination !== source) {
        claim(destination, operation.moveTo);

        const destinationExisting = await load(destination);

        if (destinationExisting) {
          throw new Error(`Cannot move to existing file: ${operation.moveTo}`);
        }

        virtual.set(source, null);
        virtual.set(destination, updatedFile);

        summaries.push(`Moved ${operation.path} -> ${operation.moveTo}`);

        continue;
      }
    }

    virtual.set(source, updatedFile);

    summaries.push(`Updated ${operation.path}`);
  }

  /*
   * Re-check files before committing.
   *
   * This prevents us from silently overwriting a file that changed
   * between reading the patch and applying it.
   */
  for (const [filePath, snapshot] of initial) {
    const current = await readSnapshot(filePath);

    if (!snapshotEquals(snapshot, current)) {
      throw new Error(
        `File changed while patch was being prepared: ${path.relative(
          root,
          filePath,
        )}`,
      );
    }
  }

  const writes: Array<[string, VirtualFile]> = [];

  const deletes: string[] = [];

  for (const [filePath, finalState] of virtual) {
    const before = initial.get(filePath);

    if (!before) {
      continue;
    }

    if (finalState === null) {
      if (before.exists) {
        deletes.push(filePath);
      }

      continue;
    }

    if (!before.exists || before.content !== finalState.content) {
      writes.push([filePath, finalState]);
    }
  }

  /*
   * Validation above happens before the first filesystem mutation.
   *
   * We additionally rollback already-applied writes/deletes if an
   * IO failure occurs during commit.
   */
  try {
    for (const [filePath, file] of writes) {
      await writeFileAtomic(filePath, file);
    }

    for (const filePath of deletes) {
      await fs.unlink(filePath);
    }
  } catch (error) {
    // Best-effort rollback.
    for (const [filePath, snapshot] of initial) {
      try {
        if (snapshot.exists) {
          await writeFileAtomic(filePath, {
            content: snapshot.content!,
            mode: snapshot.mode!,
          });
        } else {
          await fs.rm(filePath, {
            force: true,
          });
        }
      } catch {
        // Preserve the original error.
      }
    }

    throw error;
  }

  return {
    summaries,
    details: {
      changes,
      added: changes.reduce((total, change) => total + change.added, 0),
      removed: changes.reduce((total, change) => total + change.removed, 0),
    },
  };
}

export function registerApplyPatch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    renderShell: "self",

    description:
      "Apply a Codex-style patch to files in the current working directory. " +
      "Supports Add File, Delete File, Update File, multiple hunks, and Move to.",

    promptSnippet: "Apply structured patches to one or more files",

    promptGuidelines: [
      "Prefer apply_patch for code edits instead of rewriting whole files.",
      `Patch text must begin with "${BEGIN_PATCH}" and end with "${END_PATCH}".`,
      `Use "${ADD_FILE}<path>", "${UPDATE_FILE}<path>", or "${DELETE_FILE}<path>" for each file operation.`,
      "For added files, prefix every content line with +.",
      "For updates, prefix context lines with a space, removed lines with -, and added lines with +.",
      `Use "${MOVE_TO}<path>" immediately after an Update File header to rename a file.`,
    ],

    parameters: Type.Object({
      patch: Type.String({
        minLength: 1,
        description:
          "Codex-style patch text beginning with *** Begin Patch and ending with *** End Patch.",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Patch application cancelled");
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: "Applying patch...",
          },
        ],
      });

      const result = await applyPatch(ctx.cwd, params.patch);

      const text =
        result.summaries.length === 0
          ? "Patch applied successfully."
          : `Patch applied successfully.\n${result.summaries
              .map((item) => `- ${item}`)
              .join("\n")}`;

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
        details: result.details,
      };
    },

    renderCall(_args, theme, context) {
      const state = context.state as ApplyPatchRenderState;
      const component = getCallComponent(state, context.lastComponent);
      return renderPendingCall(component, theme);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = context.state as ApplyPatchRenderState;
      const callComponent = state.callComponent;

      if (isPartial) {
        return (
          (context.lastComponent as Container | undefined) ?? new Container()
        );
      }

      const errorText = context.isError
        ? result.content
            .filter((item) => item.type === "text")
            .map((item) => ("text" in item ? item.text : ""))
            .filter(Boolean)
            .join("\n")
        : undefined;

      if (callComponent) {
        renderSettledCall(
          callComponent,
          result.details as ApplyPatchDetails | undefined,
          expanded,
          theme,
          context.isError,
          errorText,
        );
      }

      const component =
        (context.lastComponent as Container | undefined) ?? new Container();
      component.clear();

      if (!callComponent) {
        const details = result.details as ApplyPatchDetails | undefined;
        const body = context.isError
          ? theme.fg("error", errorText || "Failed to apply patch")
          : details
            ? renderRichDiff(details, expanded, theme)
            : theme.fg("success", "• Patch applied");
        component.addChild(new Spacer(1));
        component.addChild(new Text(body, 0, 0));
      }

      return component;
    },
  });
}

export default registerApplyPatch;
