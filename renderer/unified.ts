import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  ApplyPatchDetails,
  DiffLine,
  DiffRendererConfig,
} from "../types.ts";
import { createInlineHighlightMap } from "./highlight.ts";
import { getUnifiedLayout } from "./layout.ts";
import {
  getChangeLabel,
  getDiffLineCount,
  type DiffModel,
} from "./model.ts";
import { colorForLine, formatStats, renderInlineSpans } from "./theme.ts";
import { distributeLineBudget, truncateLine } from "./truncate.ts";

interface SelectedDiff {
  hunks: DiffLine[][];
  selectedLines: number;
  totalLines: number;
}

function selectDiffLines(change: DiffModel, limit: number): SelectedDiff {
  const hunks: DiffLine[][] = [];
  let remaining = Math.max(0, limit);
  let selectedLines = 0;

  for (const hunk of change.diff.hunks) {
    if (remaining <= 0) break;
    const lines = hunk.lines.slice(0, remaining);
    if (lines.length > 0) hunks.push(lines);
    selectedLines += lines.length;
    remaining -= lines.length;
  }

  return {
    hunks,
    selectedLines,
    totalLines: getDiffLineCount(change.diff),
  };
}

function maxLineNumber(change: DiffModel): number {
  let maximum = 1;
  for (const hunk of change.diff.hunks) {
    maximum = Math.max(
      maximum,
      hunk.oldStart + Math.max(0, hunk.oldLines - 1),
      hunk.newStart + Math.max(0, hunk.newLines - 1),
    );
  }
  return maximum;
}

function renderContent(
  line: DiffLine,
  highlights: Map<DiffLine, import("./inline-diff.ts").InlineSpan[]>,
  wordHighlighting: boolean,
  theme: Theme,
): string {
  const spans = wordHighlighting ? highlights.get(line) : undefined;
  return spans
    ? renderInlineSpans(spans, line.type, theme)
    : theme.fg(colorForLine(line.type), line.content);
}

function renderDiffLine(
  line: DiffLine,
  numberWidth: number,
  width: number,
  showLineNumbers: boolean,
  config: DiffRendererConfig,
  highlights: Map<DiffLine, import("./inline-diff.ts").InlineSpan[]>,
  theme: Theme,
): string[] {
  const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  const number = line.type === "remove" ? line.oldLine : line.newLine;
  const numberText = showLineNumbers
    ? String(number ?? "").padStart(numberWidth, " ")
    : "";
  const bar = config.indicator === "bar" ? "│" : "";
  const gutterText = showLineNumbers
    ? `${numberText} ${bar}${sign} `
    : `${bar}${sign} `;
  const continuationText = showLineNumbers
    ? `${"".padStart(numberWidth, " ")} ${bar}  `
    : `${bar}  `;
  const gutter = theme.fg("muted", gutterText);
  const continuation = theme.fg("muted", continuationText);
  const contentWidth = Math.max(1, width - visibleWidth(gutterText));
  const styledContent = renderContent(
    line,
    highlights,
    config.wordHighlighting,
    theme,
  );

  const contentLines =
    config.longLines === "wrap"
      ? wrapTextWithAnsi(styledContent, contentWidth)
      : [truncateToWidth(styledContent, contentWidth, "…")];
  const highlightRow = (row: string): string => {
    if (line.type === "context") return row;

    // Highlight only changed rows while leaving context and the surrounding
    // tool transparent. Padding extends the tint across the diff viewport.
    const padded = `${row}${" ".repeat(Math.max(0, width - visibleWidth(row)))}`;
    return theme.bg(
      line.type === "add" ? "toolSuccessBg" : "toolErrorBg",
      padded,
    );
  };
  const rendered = (contentLines.length > 0 ? contentLines : [""]).map(
    (content, index) =>
      highlightRow(`${index === 0 ? gutter : continuation}${content}`),
  );

  if (line.noNewlineAtEnd) {
    rendered.push(
      highlightRow(
        `${continuation}${theme.fg("muted", "\\ No newline at end of file")}`,
      ),
    );
  }
  return rendered;
}

function renderFileDiff(
  change: DiffModel,
  lineBudget: number,
  width: number,
  showLineNumbers: boolean,
  config: DiffRendererConfig,
  theme: Theme,
): string[] {
  if (change.diff.hunks.length === 0) {
    return [theme.fg("muted", "  (renamed without content changes)")];
  }

  const selection = selectDiffLines(change, lineBudget);
  const selectedFlat = selection.hunks.flat();
  const highlights = config.wordHighlighting
    ? createInlineHighlightMap(selectedFlat)
    : new Map<DiffLine, import("./inline-diff.ts").InlineSpan[]>();
  const numberWidth = String(maxLineNumber(change)).length;
  const lines: string[] = [];
  let completedLogicalLines = 0;

  outer: for (let hunkIndex = 0; hunkIndex < selection.hunks.length; hunkIndex++) {
    if (hunkIndex > 0) {
      if (lines.length >= lineBudget) break;
      lines.push(theme.fg("muted", "···"));
    }

    for (const line of selection.hunks[hunkIndex]) {
      const rendered = renderDiffLine(
        line,
        numberWidth,
        width,
        showLineNumbers,
        config,
        highlights,
        theme,
      );
      const available = lineBudget - lines.length;
      if (available <= 0) break outer;
      lines.push(...rendered.slice(0, available));
      if (rendered.length <= available) completedLogicalLines++;
      else break outer;
    }
  }

  const hidden = selection.totalLines - completedLogicalLines;
  if (hidden > 0) {
    lines.push(
      theme.fg(
        "muted",
        `… ${hidden} more diff line${hidden === 1 ? "" : "s"}`,
      ),
    );
  }
  return lines;
}

function renderHeader(
  details: ApplyPatchDetails,
  width: number,
  theme: Theme,
): string {
  const fileText =
    details.stats.files > 1 ? ` ${details.stats.files} files` : "";
  const text = [
    theme.fg("success", "✓"),
    " ",
    theme.fg("toolTitle", theme.bold("Apply Patch")),
    fileText,
    " ",
    formatStats(details.stats.added, details.stats.removed, theme),
  ].join("");
  return truncateLine(text, width);
}

export function renderUnifiedDiff(
  details: ApplyPatchDetails,
  width: number,
  expanded: boolean,
  config: DiffRendererConfig,
  theme: Theme,
): string[] {
  const layout = getUnifiedLayout(width, config);
  const lines = [renderHeader(details, layout.width, theme)];
  if (layout.summaryOnly || details.changes.length === 0) return lines;

  const configuredBudget = expanded
    ? config.expandedLines
    : config.collapsedLines;
  const totalBudget = Math.min(configuredBudget, config.hardLineLimit);
  const budgets = distributeLineBudget(totalBudget, details.changes.length);

  details.changes.forEach((change, index) => {
    lines.push("");
    const label = `${getChangeLabel(change)} `;
    const heading = `${layout.indent}${theme.bold(label)}${formatStats(
      change.added,
      change.removed,
      theme,
    )}`;
    lines.push(truncateLine(heading, layout.width));

    const contentWidth = Math.max(1, layout.width - visibleWidth(layout.indent));
    const rendered = renderFileDiff(
      change,
      budgets[index],
      contentWidth,
      layout.showLineNumbers,
      config,
      theme,
    );
    for (const line of rendered) {
      lines.push(`${layout.indent}${truncateLine(line, contentWidth)}`);
    }
  });

  return lines;
}
