import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
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
});
