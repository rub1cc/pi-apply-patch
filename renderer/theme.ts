import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DiffLineType } from "../types.ts";
import type { InlineSpan } from "./inline-diff.ts";

export function formatStats(
  added: number,
  removed: number,
  theme: Theme,
): string {
  return [
    theme.fg("muted", "("),
    theme.fg("toolDiffAdded", `+${added}`),
    theme.fg("muted", " "),
    theme.fg("toolDiffRemoved", `-${removed}`),
    theme.fg("muted", ")"),
  ].join("");
}

export function colorForLine(type: DiffLineType):
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext" {
  if (type === "add") return "toolDiffAdded";
  if (type === "remove") return "toolDiffRemoved";
  return "toolDiffContext";
}

export function renderInlineSpans(
  spans: InlineSpan[],
  type: DiffLineType,
  theme: Theme,
): string {
  const color = colorForLine(type);
  return spans
    .map((span) => {
      const colored = theme.fg(color, span.text);
      return span.changed ? theme.bold(colored) : colored;
    })
    .join("");
}
