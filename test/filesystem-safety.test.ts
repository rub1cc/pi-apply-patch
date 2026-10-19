import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatch, PatchRollbackError } from "../executor.ts";
import { readSnapshot, writeFileAtomic } from "../filesystem.ts";

const roots: string[] = [];
async function root() {
  const value = await fs.mkdtemp(path.join(process.cwd(), ".patch-safety-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

test("snapshot and updates retain UTF-8 BOM", async () => {
  const cwd = await root();
  const target = path.join(cwd, "bom.txt");
  await fs.writeFile(target, "\uFEFFone\ntwo\n");
  expect((await readSnapshot(target)).content).toBe("\uFEFFone\ntwo\n");
  await applyPatch(cwd, `*** Begin Patch
*** Update File: bom.txt
@@
-two
+TWO
*** End Patch`);
  expect(await fs.readFile(target, "utf8")).toBe("\uFEFFone\nTWO\n");
});

test("all patch operations reject existing and dangling leaf symlinks", async () => {
  const cwd = await root();
  const target = path.join(cwd, "target.txt");
  await fs.writeFile(target, "keep\n");
  await fs.symlink("target.txt", path.join(cwd, "link.txt"));
  await fs.symlink("absent.txt", path.join(cwd, "dangling.txt"));
  for (const file of ["link.txt", "dangling.txt"]) {
    for (const body of [
      `*** Delete File: ${file}`,
      `*** Update File: ${file}\n@@\n-keep\n+changed`,
      `*** Add File: ${file}\n+new`,
      `*** Update File: target.txt\n*** Move to: ${file}`,
    ]) {
      await expect(applyPatch(cwd, `*** Begin Patch\n${body}\n*** End Patch`))
        .rejects.toThrow("symbolic link");
    }
  }
  expect(await fs.readFile(target, "utf8")).toBe("keep\n");
  expect((await fs.lstat(path.join(cwd, "link.txt"))).isSymbolicLink()).toBe(true);
});

test("ancestor replacement while waiting for a mutation lock fails closed", async () => {
  const cwd = await root();
  const outside = await root();
  const approved = path.join(cwd, "approved");
  await fs.mkdir(approved);
  const target = path.join(approved, "file.txt");
  await fs.writeFile(target, "before\n");
  await fs.writeFile(path.join(outside, "file.txt"), "before\n");
  let pending!: ReturnType<typeof applyPatch>;
  await withFileMutationQueue(target, async () => {
    pending = applyPatch(cwd, `*** Begin Patch
*** Update File: approved/file.txt
@@
-before
+after
*** End Patch`);
    pending.catch(() => {});
    await fs.rename(approved, path.join(cwd, "original"));
    await fs.symlink(outside, approved);
  });
  await expect(pending).rejects.toThrow("symbolic link");
  expect(await fs.readFile(path.join(outside, "file.txt"), "utf8")).toBe("before\n");
  expect(await fs.readFile(path.join(cwd, "original/file.txt"), "utf8")).toBe("before\n");
});

test("atomic filesystem writes refuse redirected ancestors", async () => {
  const cwd = await root();
  const outside = await root();
  await fs.symlink(outside, path.join(cwd, "link"));
  await expect(writeFileAtomic(path.join(cwd, "link/file.txt"), {
    content: "nope", mode: 0o600,
  })).rejects.toThrow("symbolic link");
  expect(await fs.readdir(outside)).toEqual([]);
});

test("commit failure restores attempted writes and reports failed restorations", async () => {
  const cwd = await root();
  const a = path.join(cwd, "a.txt");
  const b = path.join(cwd, "b.txt");
  const patch = `*** Begin Patch
*** Update File: a.txt
@@
-old
+new
*** Update File: b.txt
@@
-old
+new
*** End Patch`;
  for (const failRollback of [false, true]) {
    await fs.writeFile(a, "old\n");
    await fs.writeFile(b, "old\n");
    const rename = fs.rename;
    let commitFailed = false;
    fs.rename = async (from, to) => {
      if (String(to) === b && !commitFailed) {
        commitFailed = true;
        throw new Error("Injected commit failure");
      }
      if (failRollback && commitFailed && String(to) === a) {
        throw new Error("Injected rollback failure");
      }
      return rename(from, to);
    };
    let error: unknown;
    try { await applyPatch(cwd, patch); } catch (caught) { error = caught; }
    finally { fs.rename = rename; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Injected commit failure");
    expect(await fs.readFile(b, "utf8")).toBe("old\n");
    expect(await fs.readFile(a, "utf8")).toBe(failRollback ? "new\n" : "old\n");
    if (failRollback) {
      expect(error).toBeInstanceOf(PatchRollbackError);
      expect((error as PatchRollbackError).rollbackFailures).toEqual([
        { path: a, reason: "Injected rollback failure" },
      ]);
      expect((error as Error).message).toContain(a);
      expect((error as PatchRollbackError).cause).toBeInstanceOf(Error);
    }
    expect((await fs.readdir(cwd)).some((name) => name.includes(".pi-apply-"))).toBe(false);
  }
});
