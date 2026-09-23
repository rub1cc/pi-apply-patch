import type { PatchOperation, UpdateChunk } from "./types.ts";

export const BEGIN_PATCH = "*** Begin Patch";
export const END_PATCH = "*** End Patch";
export const ADD_FILE = "*** Add File: ";
export const DELETE_FILE = "*** Delete File: ";
export const UPDATE_FILE = "*** Update File: ";
export const MOVE_TO = "*** Move to: ";
export const END_OF_FILE = "*** End of File";

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

export function parsePatch(text: string): PatchOperation[] {
  const lines = normalizePatch(text).split("\n");

  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;

  if (lines[start]?.trim() !== BEGIN_PATCH) {
    throw new Error(`Patch must start with "${BEGIN_PATCH}"`);
  }

  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end--;

  if (lines[end]?.trim() !== END_PATCH) {
    throw new Error(`Patch must end with "${END_PATCH}"`);
  }

  const operations: PatchOperation[] = [];
  let i = start + 1;

  while (i < end) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith(ADD_FILE)) {
      const filePath = line.slice(ADD_FILE.length).trim();
      if (!filePath) throw new Error("Add File requires a path");

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
        content: content.join("\n") + "\n",
      });
      continue;
    }

    if (line.startsWith(DELETE_FILE)) {
      const filePath = line.slice(DELETE_FILE.length).trim();
      if (!filePath) throw new Error("Delete File requires a path");
      operations.push({ type: "delete", path: filePath });
      i++;
      continue;
    }

    if (line.startsWith(UPDATE_FILE)) {
      const filePath = line.slice(UPDATE_FILE.length).trim();
      if (!filePath) throw new Error("Update File requires a path");
      i++;

      let moveTo: string | undefined;
      if (lines[i]?.startsWith(MOVE_TO)) {
        moveTo = lines[i].slice(MOVE_TO.length).trim();
        if (!moveTo) throw new Error("Move to requires a path");
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
          currentChunk ??= { oldLines: [], newLines: [], endOfFile: true };
          currentChunk.endOfFile = true;
          i++;
          continue;
        }

        if (
          current.startsWith(" ") ||
          current.startsWith("+") ||
          current.startsWith("-")
        ) {
          currentChunk ??= {
            oldLines: [],
            newLines: [],
            endOfFile: false,
          };

          const value = current.slice(1);
          switch (current[0]) {
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
