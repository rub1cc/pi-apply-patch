import { promises as fs } from "node:fs";
import path from "node:path";
import type { Snapshot, VirtualFile } from "./types.ts";

export function resolvePatchPath(root: string, filePath: string): string {
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

export async function readSnapshot(filePath: string): Promise<Snapshot> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);

    const buffer = await fs.readFile(filePath);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`Cannot patch non-UTF-8 file: ${filePath}`);
    }

    return { exists: true, content, mode: stat.mode };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

export function snapshotEquals(a: Snapshot, b: Snapshot): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.content === b.content && (a.mode! & 0o777) === (b.mode! & 0o777);
}

export async function writeFileAtomic(
  filePath: string,
  file: VirtualFile,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const temporaryPath = path.join(
    dir,
    `.${path.basename(filePath)}.pi-apply-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );

  try {
    await fs.writeFile(temporaryPath, file.content, { mode: file.mode & 0o777 });
    await fs.chmod(temporaryPath, file.mode & 0o777);
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function removeFile(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}

export async function removeFileIfPresent(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
