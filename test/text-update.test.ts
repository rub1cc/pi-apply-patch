import { describe, expect, test } from "bun:test";
import { parsePatch } from "../parser.ts";
import { applyUpdateChunks } from "../text-update.ts";
import type { UpdateChunk } from "../types.ts";

function chunks(body: string): UpdateChunk[] {
  const operation = parsePatch(
    `*** Begin Patch\n*** Update File: file.txt\n${body}\n*** End Patch`,
  )[0];
  if (operation.type !== "update") throw new Error("Expected update");
  return operation.chunks;
}

function update(original: string, body: string): string {
  return applyUpdateChunks(original, chunks(body), "file.txt");
}

describe("original-coordinate update planning", () => {
  test("multiple hunks cannot match text inserted by a previous hunk", () => {
    expect(update("a\nb\na\n", "@@\n-a\n+b\n@@\n-b\n+c"))
      .toBe("b\nc\na\n");
    expect(() => update("a\nb\n", "@@\n-a\n+inserted\n@@\n-inserted\n+x"))
      .toThrow("Expected context was not found");
  });

  test("different-sized hunks retain original coordinates", () => {
    expect(update("a\nb\nc\nd\ne\n", "@@\n-a\n+A\n+B\n+C\n@@\n-c\n-d\n+D\n@@\n-e\n+E"))
      .toBe("A\nB\nC\nb\nD\nE\n");
  });

  test("additions-only chunks append at EOF in patch order", () => {
    expect(update("a\nb\n", "@@\n+first\n@@ a\n+second\n@@\n-b\n+B\n@@\n+third"))
      .toBe("a\nB\nfirst\nsecond\nthird\n");
  });

  test("append after an unterminated source line separates both lines", () => {
    expect(update("a", "@@\n+b\n@@\n+c")).toBe("a\nb\nc\n");
  });

  test("overlapping and backward hunks are rejected", () => {
    expect(() => update("a\nb\nc\n", "@@\n-a\n-b\n+x\n@@\n-b\n-c\n+y"))
      .toThrow("must not overlap");
    expect(() => update("a\nb\n", "@@\n-b\n+B\n@@\n-a\n+A"))
      .toThrow("must not overlap");
  });

  test("shared context is still consumed by its original-coordinate hunk", () => {
    expect(() => update("a\nb\nc\n", "@@\n-a\n+A\n b\n@@\n b\n-c\n+C"))
      .toThrow("must not overlap");
  });

  test("EOF marker targets the tail, not an earlier occurrence", () => {
    expect(update("a\nb\na\n", "@@\n-a\n+A\n*** End of File"))
      .toBe("a\nb\nA\n");
    expect(() => update("a\nb\n", "@@\n-a\n+A\n*** End of File"))
      .toThrow("Expected context was not found");
  });

  test("a jump context searches original lines after the prior hunk", () => {
    expect(update("head\na\nsection\nb\n", "@@ head\n-a\n+section\n@@ section\n-b\n+B"))
      .toBe("head\nsection\nsection\nB\n");
  });
});

describe("context and exact source bytes", () => {
  test("parser records explicit context pairs after insertion and deletion", () => {
    expect(chunks("@@\n+before\n first\n-old\n+new\n+extra\n last")[0].contextLineIndices)
      .toEqual([[0, 1], [2, 4]]);
  });

  test("fuzzy whitespace context keeps its original text and terminators", () => {
    expect(update("  head \t\r\nold\n\ttail  \r", "@@\n head\n-old\n+new\n tail"))
      .toBe("  head \t\r\nnew\r\n\ttail  \r");
  });

  test("context-only update keeps exact bytes apart from final termination", () => {
    expect(update("  a \r\nb\r", "@@\n a\n b"))
      .toBe("  a \r\nb\r");
    expect(update("  a ", "@@\n a")).toBe("  a \n");
  });

  test("changed lines use preferred ending, even for identical remove/add text", () => {
    expect(update("head\r\na\n", "@@\n head\n-a\n+a"))
      .toBe("head\r\na\r\n");
  });

  test("exact sequence match takes precedence over an earlier fuzzy one", () => {
    expect(update(" a \r\na\n", "@@\n-a\n+A"))
      .toBe(" a \r\nA\r\n");
  });

  test("trailing empty context sentinel is removed only after failed match", () => {
    expect(update("a\r\n", "@@\n-a\n+A\n ")).toBe("A\r\n");
    expect(update("a\r\n\n", "@@\n-a\n+A\n ")).toBe("A\r\n\n");
    expect(update("a", "@@\n-a\n+A\n ")).toBe("A\n");
  });

  test("trailing empty sentinel works for deletion and retains genuine blanks", () => {
    expect(update("a\n", "@@\n-a\n-")).toBe("");
    expect(update("a\n\n", "@@\n-a\n ")).toBe("\n");
  });

  test("empty-pattern retry at EOF does not invent a source line", () => {
    expect(update("", "@@\n-\n+new")).toBe("new\n");
    expect(update("", "@@\n+new\n ")).toBe("new\n");
    // Like upstream, only the *last* new-side empty line is a sentinel.
    expect(update("", "@@\n \n+new")).toBe("\nnew\n");
  });
});

describe("SourceFile line endings, empty files, and BOM", () => {
  test.each([
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"],
    ["a\rb\rc\r", "a\rB\rc\r"],
    ["a\nb\r\nc\r", "a\nB\nc\r"],
    ["a\rb\nc\r\n", "a\rB\rc\r\n"],
  ])("preserves unchanged terminators in %j", (original, expected) => {
    expect(update(original, "@@\n-b\n+B")).toBe(expected);
  });

  test("mixed endings remain exact across several separated change segments", () => {
    expect(update("a\r\nb\nc\rd\r\ne\n", "@@\n a\n-b\n+B\n c\n-d\n+D\n e"))
      .toBe("a\r\nB\r\nc\rD\r\ne\n");
  });

  test("updates terminate both changed and unchanged final lines", () => {
    expect(update("a", "@@\n-a\n+A")).toBe("A\n");
    expect(update("a\rb", "@@\n-a\n+A")).toBe("A\rb\r");
    expect(update("a\r\nb", "@@\n-a\n+A")).toBe("A\r\nb\r\n");
  });

  test("deleting all content yields an empty string, not a newline", () => {
    for (const original of ["a", "a\n", "a\r", "a\r\n", "\uFEFFa\n"]) {
      expect(update(original, "@@\n-a")).toBe("");
    }
    expect(update("\n", "@@\n-")).toBe("");
  });

  test("insertion into an empty source defaults to LF", () => {
    expect(update("", "@@\n+a\n+b")).toBe("a\nb\n");
    expect(update("", "@@\n+")).toBe("\n");
  });

  test("pure rename/no chunks returns every source byte unchanged", () => {
    for (const original of ["", "a", "\uFEFFa", "\uFEFF", "a\rb\r\nc\n"]) {
      expect(applyUpdateChunks(original, [], "file.txt")).toBe(original);
    }
  });

  test("BOM stays at the beginning when the first line is replaced or removed", () => {
    expect(update("\uFEFFa\r\nb\n", "@@\n-a\n+A"))
      .toBe("\uFEFFA\r\nb\n");
    expect(update("\uFEFFa\r\nb\n", "@@\n-a"))
      .toBe("\uFEFFb\n");
    expect(update("\uFEFF", "@@\n+new")).toBe("\uFEFFnew\n");
    expect(update("\uFEFFa", "@@\n a\n+new")).toBe("\uFEFFa\nnew\n");
  });

  test("empty Add differs from adding a blank line", () => {
    const empty = parsePatch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch")[0];
    const blank = parsePatch("*** Begin Patch\n*** Add File: blank.txt\n+\n*** End Patch")[0];
    expect(empty).toEqual({ type: "add", path: "empty.txt", content: "" });
    expect(blank).toEqual({ type: "add", path: "blank.txt", content: "\n" });
  });
});
