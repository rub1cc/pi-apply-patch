import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import registerApplyPatch from "../index.ts";
import { createDiff } from "../renderer/diff.ts";
import { createInlineDiff } from "../renderer/inline-diff.ts";
import { normalizeApplyPatchDetails } from "../renderer/normalize.ts";
import { parseUnifiedDiff } from "../renderer/parse.ts";
import { renderUnifiedDiff } from "../renderer/unified.ts";
import {
  DEFAULT_DIFF_RENDERER_CONFIG,
  type AppliedFileChange,
  type ApplyPatchDetails,
} from "../types.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;

function detailsFor(
  oldContent: string,
  newContent: string,
  path = "src/example.ts",
): ApplyPatchDetails {
  const diff = createDiff(oldContent, newContent);
  const change: AppliedFileChange = {
    type: "update",
    path,
    oldContent,
    newContent,
    added: diff.stats.added,
    removed: diff.stats.removed,
    diff,
  };
  return {
    changes: [change],
    stats: { files: 1, added: change.added, removed: change.removed },
  };
}

describe("diff model", () => {
  test("tracks hunks, line numbers, stats, and missing final newlines", () => {
    const diff = createDiff("a\nb\nc", "a\nB\nc\n");
    expect(diff.stats).toEqual({ added: 2, removed: 2 });
    expect(
      diff.hunks[0].lines.map(
        ({ type, oldLine, newLine, noNewlineAtEnd }) => [
          type,
          oldLine,
          newLine,
          noNewlineAtEnd,
        ],
      ),
    ).toEqual([
      ["context", 1, 1, undefined],
      ["remove", 2, undefined, undefined],
      ["remove", 3, undefined, true],
      ["add", undefined, 2, undefined],
      ["add", undefined, 3, undefined],
    ]);
  });

  test("parses multiple standard unified hunks", () => {
    const parsed = parseUnifiedDiff(`--- file
+++ file
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -10,1 +10,2 @@
 x
+y
`);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.stats).toEqual({ added: 2, removed: 1 });
  });
});

describe("inline diff", () => {
  test("marks changed tokens independently from unchanged text", () => {
    const result = createInlineDiff("const user = oldUser;", "const user = newUser;");
    expect(result.oldSpans.filter((span) => span.changed).map((span) => span.text)).toEqual([
      "oldUser",
    ]);
    expect(result.newSpans.filter((span) => span.changed).map((span) => span.text)).toEqual([
      "newUser",
    ]);
  });
});

describe("unified renderer", () => {
  const details = detailsFor(
    "export function run() {\n  return oldCall();\n}\n",
    "export function run() {\n  const value = newCall();\n  return value;\n}\n",
  );

  test("renders line numbers and separate add/remove rows", () => {
    const output = renderUnifiedDiff(
      details,
      100,
      false,
      { ...DEFAULT_DIFF_RENDERER_CONFIG },
      theme,
    )
      .map(stripTerminalSequences)
      .join("\n");

    expect(output).toContain("• Edited src/example.ts (+2 -1)");
    expect(output.match(/src\/example\.ts/g)).toHaveLength(1);
    expect(output).toContain("2 │-   return oldCall();");
    expect(output).toContain("2 │+   const value = newCall();");
  });

  test("uses compact output and never exceeds the terminal width", () => {
    const lines = renderUnifiedDiff(
      details,
      32,
      false,
      { ...DEFAULT_DIFF_RENDERER_CONFIG },
      theme,
    );
    expect(lines.map(stripTerminalSequences).join("\n")).not.toContain("1 │");
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  test("wraps long lines and truncates large collapsed diffs", () => {
    const many = detailsFor(
      Array.from({ length: 60 }, (_, index) => `old ${index}`).join("\n"),
      Array.from(
        { length: 60 },
        (_, index) => `new ${index} ${"long ".repeat(10)}`,
      ).join("\n"),
    );
    const lines = renderUnifiedDiff(
      many,
      60,
      false,
      { ...DEFAULT_DIFF_RENDERER_CONFIG, collapsedLines: 8 },
      theme,
    );
    expect(lines.map(stripTerminalSequences).join("\n")).toContain(
      "more diff lines",
    );
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  test("shows a summary only at very narrow widths", () => {
    const lines = renderUnifiedDiff(
      details,
      20,
      false,
      { ...DEFAULT_DIFF_RENDERER_CONFIG },
      theme,
    );
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(20);
  });

  test("renders multi-file patch and per-file summaries", () => {
    const first = detailsFor("old\n", "new\n", "src/one.ts").changes[0];
    const second = detailsFor("", "added\n", "src/two.ts").changes[0];
    const multi: ApplyPatchDetails = {
      changes: [first, { ...second, type: "add" }],
      stats: {
        files: 2,
        added: first.added + second.added,
        removed: first.removed + second.removed,
      },
    };
    const output = renderUnifiedDiff(
      multi,
      100,
      false,
      { ...DEFAULT_DIFF_RENDERER_CONFIG },
      theme,
    )
      .map(stripTerminalSequences)
      .join("\n");

    expect(output).toContain("• Edited 2 files");
    expect(output).toContain("src/one.ts");
    expect(output).toContain("Added src/two.ts");
  });
});

describe("apply_patch activity states", () => {
  test("uses bullet-based pending and failure states", () => {
    const tools: any[] = [];
    registerApplyPatch({
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as any);
    const tool = tools[0];
    const state: Record<string, unknown> = {};
    const baseContext = {
      args: { patch: "*** Begin Patch\n*** End Patch" },
      toolCallId: "patch-1",
      invalidate() {},
      lastComponent: undefined,
      state,
      cwd: "/repo",
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
    };

    const call = tool.renderCall(baseContext.args, theme, baseContext);
    expect(call.render(80).map(stripTerminalSequences).join("\n")).toContain(
      "• Applying patch",
    );

    tool.renderResult(
      { content: [{ type: "text", text: "Patch context was not found" }] },
      { expanded: false, isPartial: false },
      theme,
      { ...baseContext, isPartial: false, isError: true },
    );
    const failed = call.render(80).map(stripTerminalSequences).join("\n");
    expect(failed).toContain("• Failed to apply patch");
    expect(failed).toContain("└ Patch context was not found");
    expect(failed).not.toContain("✓");
  });
});

describe("renderer details compatibility", () => {
  test("normalizes details persisted by the previous renderer", () => {
    const details = normalizeApplyPatchDetails({
      changes: [
        {
          type: "update",
          path: "legacy.ts",
          added: 1,
          removed: 1,
          diff: " 1 before\n-2 old\n+2 new\n 3 after",
        },
      ],
      added: 1,
      removed: 1,
    });

    expect(details?.stats).toEqual({ files: 1, added: 1, removed: 1 });
    expect(details?.changes[0].diff.hunks[0].lines).toHaveLength(4);

    const output = renderUnifiedDiff(
      details!,
      80,
      false,
      { ...DEFAULT_DIFF_RENDERER_CONFIG },
      theme,
    )
      .map(stripTerminalSequences)
      .join("\n");
    expect(output).toContain("2 │- old");
    expect(output).toContain("2 │+ new");
  });

  test("rejects malformed details instead of passing them to the renderer", () => {
    expect(normalizeApplyPatchDetails({})).toBeUndefined();
    expect(
      normalizeApplyPatchDetails({ changes: [{ type: "update" }] }),
    ).toBeUndefined();
  });
});
