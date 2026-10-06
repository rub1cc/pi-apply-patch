import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatch, applyUpdateChunks } from "../executor.ts";
import { parsePatch } from "../parser.ts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".apply-patch-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("parsePatch", () => {
  test("parses every operation and multiple hunks", () => {
    const operations = parsePatch(`
*** Begin Patch
*** Add File: added.txt
+hello
*** Update File: old.txt
*** Move to: moved.txt
@@ first
-one
+ONE
@@ second
-two
+TWO
*** Delete File: deleted.txt
*** End Patch
`);

    expect(operations.map((operation) => operation.type)).toEqual([
      "add",
      "update",
      "delete",
    ]);
    expect(operations[1]).toMatchObject({
      path: "old.txt",
      moveTo: "moved.txt",
      chunks: [{ context: "first" }, { context: "second" }],
    });
  });
});

describe("applyUpdateChunks", () => {
  test("preserves CRLF endings", () => {
    const result = applyUpdateChunks(
      "one\r\ntwo\r\n",
      [{ oldLines: ["two"], newLines: ["TWO"], endOfFile: false }],
      "file.txt",
    );
    expect(result).toBe("one\r\nTWO\r\n");
  });
});

describe("applyPatch", () => {
  test("respects umask for new files and preserves existing modes", async () => {
    const root = await makeRoot();
    const existing = path.join(root, "existing.txt");
    await fs.writeFile(existing, "old\n");
    await fs.chmod(existing, 0o755);
    const previous = process.umask(0o077);
    try {
      await applyPatch(root, `*** Begin Patch
*** Add File: new.txt
+private
*** Update File: existing.txt
@@
-old
+new
*** End Patch`);
      expect((await fs.stat(path.join(root, "new.txt"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(existing)).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previous);
    }
  });

  test("waits for the host mutation queue before taking snapshots", async () => {
    const root = await makeRoot();
    const target = path.join(root, "queued.txt");
    await fs.writeFile(target, "before\n");
    let pending!: ReturnType<typeof applyPatch>;
    let settled = false;
    await withFileMutationQueue(target, async () => {
      pending = applyPatch(root, `*** Begin Patch
*** Update File: queued.txt
@@
-ready
+patched
*** End Patch`);
      // Handle both outcomes immediately, even if this regression fails.
      pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      await fs.writeFile(target, "ready\n");
    });
    await pending;
    expect(await fs.readFile(target, "utf8")).toBe("patched\n");
  });

  test("locks move destinations and releases locks after cancellation", async () => {
    const root = await makeRoot();
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await fs.writeFile(source, "keep\n");
    const controller = new AbortController();
    let pending!: ReturnType<typeof applyPatch>;
    let settled = false;
    await withFileMutationQueue(destination, async () => {
      pending = applyPatch(root, `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
*** End Patch`, controller.signal);
      pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      controller.abort();
    });
    await expect(pending).rejects.toThrow("cancelled");
    expect(await fs.readFile(source, "utf8")).toBe("keep\n");
    await applyPatch(root, `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
*** End Patch`);
    expect(await fs.readFile(destination, "utf8")).toBe("keep\n");
  });

  test("deduplicates canonical locks for aliases", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "file.txt"), "same\n");
    await fs.symlink("file.txt", path.join(root, "alias.txt"));
    await applyPatch(root, `*** Begin Patch
*** Update File: alias.txt
*** Move to: file.txt
*** End Patch`);
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("same\n");
  });

  test("serializes overlapping patches with reversed path order", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "a.txt"), "a\n");
    await fs.writeFile(path.join(root, "b.txt"), "b\n");
    const patch = (names: string[]) => `*** Begin Patch\n${names.map((name) =>
      `*** Update File: ${name}.txt\n@@\n-${name}\n+${name}`,
    ).join("\n")}\n*** End Patch`;
    await Promise.all([
      applyPatch(root, patch(["a", "b"])),
      applyPatch(root, patch(["b", "a"])),
    ]);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("a\n");
  });

  test("applies add, update, delete, move, and multiple files atomically", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "update.txt"), "one\ntwo\nthree\n");
    await fs.writeFile(path.join(root, "delete.txt"), "obsolete\n");
    await fs.writeFile(path.join(root, "old.txt"), "before\n");

    const result = await applyPatch(
      root,
      `*** Begin Patch
*** Add File: nested/added.txt
+new
*** Update File: update.txt
@@
-one
+ONE
@@
-three
+THREE
*** Delete File: delete.txt
*** Update File: old.txt
*** Move to: moved.txt
@@
-before
+after
*** End Patch`,
    );

    expect(await fs.readFile(path.join(root, "nested/added.txt"), "utf8")).toBe(
      "new\n",
    );
    expect(await fs.readFile(path.join(root, "update.txt"), "utf8")).toBe(
      "ONE\ntwo\nTHREE\n",
    );
    expect(await fs.readFile(path.join(root, "moved.txt"), "utf8")).toBe(
      "after\n",
    );
    expect(await fs.stat(path.join(root, "delete.txt")).catch(() => undefined)).toBe(
      undefined,
    );
    expect(await fs.stat(path.join(root, "old.txt")).catch(() => undefined)).toBe(
      undefined,
    );
    expect(result.details.changes.map((change) => change.type)).toEqual([
      "add",
      "update",
      "delete",
      "move",
    ]);
    expect(result.details.stats).toEqual({ files: 4, added: 4, removed: 4 });
  });

  test("supports a pure rename", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "old.txt"), "same\n");

    const result = await applyPatch(
      root,
      `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
*** End Patch`,
    );

    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("same\n");
    expect(result.details.changes[0]).toMatchObject({
      type: "move",
      added: 0,
      removed: 0,
    });
  });

  test("rejects unsafe and conflicting operations before mutating files", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "keep.txt"), "keep\n");

    await expect(
      applyPatch(
        root,
        `*** Begin Patch
*** Update File: keep.txt
@@
-keep
+changed
*** Delete File: missing.txt
*** End Patch`,
      ),
    ).rejects.toThrow("Cannot delete missing file");
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep\n");

    await expect(
      applyPatch(
        root,
        `*** Begin Patch
*** Add File: ../escape.txt
+nope
*** End Patch`,
      ),
    ).rejects.toThrow("Path escapes the working directory");

    await expect(
      applyPatch(
        root,
        `*** Begin Patch
*** Add File: keep.txt
+duplicate
*** End Patch`,
      ),
    ).rejects.toThrow("already exists");
  });

  test("rejects writes through a symlinked parent outside the root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fs.symlink(outside, path.join(root, "linked"));

    await expect(
      applyPatch(
        root,
        `*** Begin Patch
*** Add File: linked/escaped.txt
+nope
*** End Patch`,
      ),
    ).rejects.toThrow("escapes the working directory through a symlink");
    expect(
      await fs.stat(path.join(outside, "escaped.txt")).catch(() => undefined),
    ).toBe(undefined);
  });

  test("accepts a checked canonical target when the root is a symlink", async () => {
    const root = await makeRoot();
    const aliasParent = await makeRoot();
    const alias = path.join(aliasParent, "root-alias");
    await fs.symlink(root, alias);
    const target = path.join(await fs.realpath(root), "canonical.txt");

    await applyPatch(
      alias,
      `*** Begin Patch
*** Add File: ${target}
+safe
*** End Patch`,
    );

    expect(await fs.readFile(path.join(root, "canonical.txt"), "utf8")).toBe(
      "safe\n",
    );
  });
});
