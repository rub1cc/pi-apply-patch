import { lstatSync, readlinkSync, realpathSync } from "node:fs";
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
  const canonicalResolved = canonicalizePathSync(resolved);
  if (!isWithin(canonicalResolved, canonicalRoot) || canonicalResolved === canonicalRoot) {
    throw new Error(`Path escapes the working directory through a symlink: ${filePath}`);
  }

  return canonicalResolved;
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
