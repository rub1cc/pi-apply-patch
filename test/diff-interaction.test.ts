import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import registerApplyPatch from "../index.ts";
import { createDiffComponent } from "../renderer/component.ts";
import { createDiff } from "../renderer/diff.ts";
import type { ApplyPatchDetails } from "../types.ts";

beforeAll(async () => { await initTheme("light", false); });

function details(): ApplyPatchDetails {
  const newContent = Array.from({ length: 80 }, (_, i) => `row-${i}`).join("\n") + "\n";
  const diff = createDiff("", newContent);
  return {
    changes: [{ type: "add", path: "new.ts", oldContent: "", newContent,
      diff, added: 80, removed: 0 }],
    stats: { files: 1, added: 80, removed: 0 },
  };
}

function rows(component: { render(width: number): string[] }, width = 80) {
  return component.render(width).map(stripTerminalSequences);
}

function fixture() {
  let definition: any;
  let redraws = 0;
  registerApplyPatch({ registerTool: (tool: any) => { definition = tool; } } as any);
  const args = { patch: "*** Begin Patch\n*** Add File: new.ts\n+row\n*** End Patch" };
  const host = new ToolExecutionComponent("apply_patch", "patch-1", args, {}, definition,
    { requestRender() { redraws++; } } as any, "/repo");
  host.markExecutionStarted();
  host.updateResult({ content: [{ type: "text", text: "Applied" }], details: details(), isError: false });
  return { host, redraws: () => redraws };
}

function click(host: ToolExecutionComponent, y: number) {
  const height = host.render(80).length;
  return host.handleMouse({ type: "click", button: "left", x: 3, y, width: 80, height });
}

describe("full-by-default diff interaction", () => {
  test("native Patch headers and body clicks toggle all rows without losing state on redraw", () => {
    const { host, redraws } = fixture();
    expect(rows(host).join("\n")).toContain("row-79");
    expect(rows(host).join("\n")).toContain("click to collapse");
    expect(rows(host).join("\n")).toContain("• Patch(new.ts)");

    expect(click(host, 1)?.handled).toBe(true);
    expect(rows(host).join("\n")).not.toContain("row-79");
    expect(rows(host).join("\n")).toContain("more diff rows");
    expect(rows(host).join("\n")).toContain("click to expand");
    host.invalidate();
    expect(rows(host).join("\n")).not.toContain("row-79");
    for (const width of [1, 4, 20, 40, 120]) {
      expect(host.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
    }
    expect(click(host, 3)?.handled).toBe(true);
    expect(rows(host).join("\n")).toContain("row-79");
    expect(redraws()).toBeGreaterThanOrEqual(3);
  });

  test("global expansion signals remain absolute after local toggles", () => {
    const { host } = fixture();
    click(host, 1);
    host.setExpanded(true);
    expect(rows(host).join("\n")).toContain("row-79");
    host.setExpanded(false);
    expect(rows(host).join("\n")).not.toContain("row-79");
    host.invalidate();
    expect(rows(host).join("\n")).not.toContain("row-79");
    host.setExpanded(true);
    expect(rows(host).join("\n")).toContain("row-79");
  });

  test("the shared component supports explicit compact initial views and ignores non-clicks", () => {
    const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text,
      bold: (text: string) => text } as Theme;
    const component = createDiffComponent({ details: details(), expanded: false, defaultExpanded: false, theme });
    expect(rows(component).join("\n")).not.toContain("row-79");
    expect(component.handleMouse?.({ type: "move", x: 0, y: 0, width: 80, height: 80 })).toBeUndefined();
    component.toggleExpanded();
    expect(rows(component).join("\n")).toContain("row-79");
  });
});
