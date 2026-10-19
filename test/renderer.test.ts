import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createDiffComponent } from "../renderer/component.ts";
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

    expect(output).toContain("Patch(src/example.ts) (+2 -1)");
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
      "more diff rows",
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

    expect(output).toContain("Patch(2 files)");
    expect(output).toContain("src/one.ts");
    expect(output).toContain("Added src/two.ts");
  });

  test("uses the same alias for every operation and sanitizes header paths", () => {
    for (const type of ["add", "delete", "update", "move"] as const) {
      const single = detailsFor("old\n", "new\n", "\u001b[31msrc/file\u001b[0m\n\t\u0007.ts");
      single.changes[0] = type === "move"
        ? { ...single.changes[0], type, moveTo: "dest\r\n.ts" }
        : { ...single.changes[0], type };
      const header = renderUnifiedDiff(single, 100, false, DEFAULT_DIFF_RENDERER_CONFIG, theme)[0];
      expect(header).toBe(`• Patch(src/file  .ts${type === "move" ? " → dest  .ts" : ""}) (+1 -1)`);
      expect(header).not.toContain("\u001b");
    }
    const empty = { changes: [], stats: { files: 0, added: 0, removed: 0 } };
    expect(renderUnifiedDiff(empty, 80, false, DEFAULT_DIFF_RENDERER_CONFIG, theme)[0]).toBe("• Patch() (+0 -0)");
  });

  test("preserves completed title, path, statistics and small status dot colors", () => {
    const colors: [string, string][] = [];
    const trackedTheme = { ...theme, fg: (color: string, value: string) => {
      colors.push([color, value]);
      return value;
    } } as Theme;
    const lines = renderUnifiedDiff(details, 100, false, DEFAULT_DIFF_RENDERER_CONFIG, trackedTheme);
    expect(lines[0]).toBe("• Patch(src/example.ts) (+2 -1)");
    expect(colors).toContainEqual(["toolTitle", "Patch("]);
    expect(colors).toContainEqual(["accent", "src/example.ts"]);
    expect(colors).toContainEqual(["success", "•"]);
  });
});

describe("complete diff presentation", () => {
  const config = { ...DEFAULT_DIFF_RENDERER_CONFIG };
  const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
  const additions = (count: number, path = "large.ts") => detailsFor(
    "", Array.from({ length: count }, (_, i) => `row-${i}`).join("\n") + "\n", path,
  );

  for (const count of [150, 650]) {
    test(`expansion renders all ${count} lines despite legacy limits`, () => {
      const details = additions(count);
      const component = createDiffComponent({ details, expanded: true,
        config: { expandedLines: 2, hardLineLimit: 3 }, theme });
      const lines = component.render(80);
      expect(lines).toHaveLength(count + 1); // no configured shortcut in standalone tests
      for (let i = 0; i < count; i++) expect(plain(lines)).toContain(`row-${i}`);
      expect(plain(lines)).not.toContain("more diff rows");
      expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    });
  }

  test("expansion wraps the entire long tail even with truncate configured", () => {
    const details = detailsFor("", "x".repeat(20000) + "TAIL_END\n");
    const component = createDiffComponent({ details, expanded: true,
      config: { longLines: "truncate" }, theme });
    const lines = component.render(40);
    expect(lines.length).toBeGreaterThan(500);
    const contents = lines.slice(1).map((line) => stripTerminalSequences(line).slice(5).trimEnd()).join("");
    expect(contents).toBe("x".repeat(20000) + "TAIL_END");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(component.render(40)).toBe(lines);
    component.invalidate();
    expect(component.render(40)).toEqual(lines);
    expect(component.render(60).length).toBeLessThan(lines.length);
  });

  test("small uneven multi-file diffs use the full shared preview budget", () => {
    for (const counts of [[1, 23], [23, 1], [1, 1, 22]]) {
      const changes = counts.map((count, i) => additions(count, `file-${i}.ts`).changes[0]);
      const details = { changes, stats: { files: counts.length, added: 24, removed: 0 } };
      const lines = renderUnifiedDiff(details, 80, false, config, theme);
      expect(plain(lines)).not.toContain("more diff rows");
      expect(lines.filter((line) => line.includes("│+"))).toHaveLength(24);
    }
  });

  test("small wrapped multi-file diffs remain complete even with truncate configured", () => {
    const changes = [
      detailsFor("", "short\n", "short.ts").changes[0],
      detailsFor("", "x".repeat(300) + "TAIL\n", "wrapped.ts").changes[0],
    ];
    const details = { changes, stats: { files: 2, added: 2, removed: 0 } };
    const lines = renderUnifiedDiff(details, 40, false, { ...config, longLines: "truncate" }, theme);
    expect(plain(lines)).toContain("TAIL");
    expect(plain(lines)).not.toContain("more diff rows");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  test("expanded multi-hunk diffs preserve final additions and deletions", () => {
    const oldContent = Array.from({ length: 700 }, (_, i) => `before-${i}`).join("\n") + "\n";
    const newContent = oldContent.replace("before-0\n", "after-0\n").replace("before-699\n", "after-699\n");
    const details = detailsFor(oldContent, newContent);
    expect(details.changes[0].diff.hunks.length).toBeGreaterThan(1);
    const output = plain(renderUnifiedDiff(details, 80, true, { ...config, expandedLines: 1, hardLineLimit: 1 }, theme));
    expect(output).toContain("before-699");
    expect(output).toContain("after-699");
    expect(output).not.toContain("more diff rows");
  });

  test("narrow expansion shows content and missing-newline notes within width", () => {
    for (const width of [1, 2, 3, 4, 10, 20, 23]) {
      const lines = renderUnifiedDiff(detailsFor("", "abcdefghij"), width, true, config, theme);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(plain(lines)).toContain("a");
      expect(plain(lines)).toContain("j");
      const wide = renderUnifiedDiff(detailsFor("", "界界\n"), width, true, config, theme);
      expect(wide.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  test("configured hints track collapsed/expanded/collapsed tool states", () => {
    const previous = getKeybindings();
    setKeybindings(new KeybindingsManager({
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tools" },
    }, { "app.tools.expand": "ctrl+y" }));
    try {
      const tools: any[] = [];
      registerApplyPatch({ registerTool: (tool: unknown) => tools.push(tool) } as any);
      const tool = tools[0];
      const context = { state: {}, lastComponent: undefined, isError: false, invalidate() {} };
      const call = tool.renderCall({}, theme, context);
      const result = { content: [], details: additions(650) };
      for (const [expanded, full] of [[false, true], [true, true], [false, false]]) {
        tool.renderResult(result, { expanded, isPartial: false }, theme, context);
        const output = plain(call.render(80));
        expect(output).toContain(`click to ${full ? "collapse" : "expand"}`);
        expect(output).toContain("ctrl+y to toggle all");
        expect(output).not.toContain("ctrl+o");
        expect(output.includes("row-649")).toBe(full);
        expect(output.includes("more diff rows")).toBe(!full);
      }
      const small = plain(renderUnifiedDiff(additions(2), 80, false, config, theme));
      expect(small).not.toContain("to expand");
      const narrow = renderUnifiedDiff(additions(50), 20, false, config, theme);
      expect(plain(narrow)).toContain("ctrl+y to expand");
      expect(narrow.every((line) => visibleWidth(line) <= 20)).toBe(true);
      setKeybindings(new KeybindingsManager({
        "app.tools.expand": { defaultKeys: [], description: "Toggle tools" },
      }));
      expect(plain(renderUnifiedDiff(additions(50), 80, false, config, theme))).not.toContain("to expand");
    } finally {
      setKeybindings(previous);
    }
  });
});

describe("apply_patch activity states", () => {
  test("uses small activity dots with accented pending and red failure labels", () => {
    const tools: any[] = [];
    registerApplyPatch({
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as any);
    const tool = tools[0];
    const state: Record<string, unknown> = {};
    const baseContext = {
      args: { patch: "*** Begin Patch\n*** Add File: src/new.ts\n+private body\n*** End Patch" },
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

    const colors: [string, string][] = [];
    const trackedTheme = { ...theme, fg: (color: string, value: string) => {
      colors.push([color, value]);
      return value;
    } } as Theme;
    const call = tool.renderCall(baseContext.args, trackedTheme, baseContext);
    expect(call.render(80).map(stripTerminalSequences).join("\n").trimEnd()).toBe(
      "• Patch(src/new.ts)",
    );
    expect(colors).toContainEqual(["accent", "Patch(src/new.ts)"]);

    tool.renderResult(
      { content: [{ type: "text", text: "Patch context was not found" }] },
      { expanded: false, isPartial: false },
      trackedTheme,
      { ...baseContext, isPartial: false, isError: true },
    );
    const failed = call.render(80).map(stripTerminalSequences).join("\n");
    expect(failed.split("\n")[0].trimEnd()).toBe("• Patch(src/new.ts) Failed");
    expect(colors).toContainEqual(["error", "Patch(src/new.ts) Failed"]);
    expect(failed).toContain("└ Patch context was not found");
    expect(failed).toStartWith("• ");
    expect(failed).not.toMatch(/^[●⏺]/u);
    expect(failed).not.toContain("private body");
  });

  test("summarizes only parsed paths without invoking execution", () => {
    let tool: any;
    registerApplyPatch({ registerTool: (registered: unknown) => { tool = registered; } } as any);
    const cases: [unknown, string][] = [
      [undefined, "Patch()"],
      [{}, "Patch()"],
      [{ patch: 12 }, "Patch()"],
      [{ patch: "secret patch body" }, "Patch()"],
      [{ patch: "*** Begin Patch\n*** Update File: incomplete.ts\n@@\n-old" }, "Patch()"],
      [{ patch: "*** Begin Patch\n*** Delete File: missing.ts\n*** End Patch" }, "Patch(missing.ts)"],
      [{ patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** End Patch" }, "Patch(old.ts → new.ts)"],
      [{ patch: "*** Begin Patch\r\n*** Add File: one.ts\r\n+*** Add File: not-a-path.ts\r\n*** Delete File: two.ts\r\n*** End Patch" }, "Patch(2 files)"],
      [{ patch: "*** Begin Patch\n*** Add File: \u001b[31msafe\u001b[0m\tname\u0007.ts\n+secret body\n*** End Patch" }, "Patch(safe name.ts)"],
    ];
    for (const [args, expected] of cases) {
      const context = { state: {}, lastComponent: undefined };
      const call = tool.renderCall(args, theme, context);
      expect(call.render(100).map(stripTerminalSequences).join("\n").trimEnd()).toBe(`• ${expected}`);
    }
  });

  test("renders success and error labels even without a preceding call", () => {
    let tool: any;
    registerApplyPatch({ registerTool: (registered: unknown) => { tool = registered; } } as any);
    const plain = (component: any) => component.render(100).map(stripTerminalSequences).join("\n").trimEnd();
    const options = { expanded: false, isPartial: false };
    const args = { patch: "*** Begin Patch\n*** Delete File: missing.ts\n*** End Patch" };
    for (const withCall of [false, true]) {
      for (const isError of [false, true]) {
        const context = { state: {}, lastComponent: undefined, args, isError };
        const call = withCall ? tool.renderCall(args, theme, context) : undefined;
        const result = tool.renderResult({ content: [{ type: "text", text: "error details" }] }, options, theme, context);
        const output = plain(call ?? result);
        expect(output.split("\n")[0].trimEnd()).toBe(`• Patch(missing.ts)${isError ? " Failed" : ""}`);
        expect(output.includes("error details")).toBe(isError);
      }
    }
    for (const isError of [false, true]) {
      const output = plain(tool.renderResult({ content: [] }, options, theme, { state: {}, isError }));
      expect(output).toBe(`• Patch()${isError ? " Failed" : ""}`);
    }
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
