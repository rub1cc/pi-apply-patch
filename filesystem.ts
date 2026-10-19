import { constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Snapshot, VirtualFile } from "./types.ts";

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function canonicalizePathSync(
  value: string,
  visited = new Set<string>(),
): string {
  const normalized = path.resolve(value);
  if (visited.has(normalized)) {
    throw new Error(`Symlink cycle while resolving patch path: ${normalized}`);
  }
  visited.add(normalized);

  const root = path.parse(normalized).root;
  const components = path.relative(root, normalized).split(path.sep).filter(Boolean);
  let current = root;

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    const candidate = path.resolve(current, component);
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        const link = readlinkSync(candidate);
        const target = path.isAbsolute(link)
          ? path.resolve(link)
          : path.resolve(path.dirname(candidate), link);
        return canonicalizePathSync(
          path.resolve(target, ...components.slice(index + 1)),
          visited,
        );
      }
      current = realpathSync(candidate);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      return path.resolve(current, ...components.slice(index));
    }
  }

  return current;
}

export function resolvePatchPath(root: string, filePath: string): string {
  if (filePath.includes("\0")) {
    throw new Error("File path contains a null byte");
  }

  const resolvedRoot = path.resolve(root);
  const inputIsAbsolute = path.isAbsolute(filePath);
  const resolved = inputIsAbsolute
    ? path.normalize(filePath)
    : path.resolve(resolvedRoot, filePath);

  if (
    !inputIsAbsolute &&
    (!isWithin(resolved, resolvedRoot) || resolved === resolvedRoot)
  ) {
    throw new Error(`Path escapes the working directory: ${filePath}`);
  }

  const canonicalRoot = canonicalizePathSync(resolvedRoot);
  // A patch must never reinterpret a leaf symlink as its target (especially
  // Delete File). Reject both existing and dangling leaf links explicitly.
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Cannot patch a symbolic link: ${filePath}`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const canonicalResolved = canonicalizePathSync(resolved);
  if (!isWithin(canonicalResolved, canonicalRoot) || canonicalResolved === canonicalRoot) {
    throw new Error(`Path escapes the working directory through a symlink: ${filePath}`);
  }

  return canonicalResolved;
}

/** Detect retargeting of any existing component of an already pinned path. */
export function assertPinnedPath(filePath: string): void {
  const absolute = path.resolve(filePath);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Patch path changed through a symbolic link: ${current}`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function readSnapshot(filePath: string): Promise<Snapshot> {
  assertPinnedPath(filePath);
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);

    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let buffer: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new Error(`File changed while opening patch snapshot: ${filePath}`);
      }
      buffer = await handle.readFile();
      assertPinnedPath(filePath);
    } finally {
      await handle.close();
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
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
  assertPinnedPath(filePath);
  await fs.mkdir(dir, { recursive: true });
  assertPinnedPath(filePath);

  const temporaryPath = path.join(
    dir,
    `.${path.basename(filePath)}.pi-apply-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );

  try {
    const handle = await fs.open(temporaryPath, "wx", file.mode & 0o777);
    try {
      await handle.writeFile(file.content);
      await handle.chmod(file.mode & 0o777);
    } finally {
      await handle.close();
    }
    assertPinnedPath(filePath);
    assertPinnedPath(temporaryPath);
    await fs.rename(temporaryPath, filePath);
  } finally {
    try {
      assertPinnedPath(temporaryPath);
      await fs.rm(temporaryPath, { force: true });
    } catch {
      // Never follow a redirected directory during best-effort cleanup.
    }
  }
}

export async function removeFile(filePath: string): Promise<void> {
  assertPinnedPath(filePath);
  await fs.unlink(filePath);
}

export async function removeFileIfPresent(filePath: string): Promise<void> {
  assertPinnedPath(filePath);
  await fs.rm(filePath, { force: true });
}
