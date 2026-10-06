import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
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
  getChangePath,
  type DiffModel,
} from "./model.ts";
import { colorForLine, formatStats, renderInlineSpans } from "./theme.ts";
import { truncateLine } from "./truncate.ts";

// Allocate visual rows fairly, returning unused shares from short files.
function allocateRows(sizes: number[], total: number): number[] {
  const budgets = sizes.map(() => 0);
  let remaining = Math.max(0, Math.floor(total));
  while (remaining > 0) {
    const active = sizes.flatMap((size, index) =>
      budgets[index] < size ? [index] : [],
    );
    if (active.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const index of active) {
      const count = Math.min(share, sizes[index] - budgets[index], remaining);
      budgets[index] += count;
      remaining -= count;
    }
  }
  return budgets;
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
  const gutterText = width < 4
    ? (width > 1 ? sign : "")
    : showLineNumbers ? `${numberText} ${bar}${sign} ` : `${bar}${sign} `;
  const continuationText = width < 4
    ? " ".repeat(gutterText.length)
    : showLineNumbers ? `${"".padStart(numberWidth, " ")} ${bar}  ` : `${bar}  `;
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
    for (const note of wrapTextWithAnsi(
      theme.fg("muted", "\\ No newline at end of file"), contentWidth,
    )) {
      rendered.push(highlightRow(`${continuation}${note}`));
    }
  }
  return rendered;
}

function renderFileDiff(
  change: DiffModel,
  width: number,
  showLineNumbers: boolean,
  config: DiffRendererConfig,
  theme: Theme,
): string[] {
  if (change.diff.hunks.length === 0) {
    return wrapTextWithAnsi(theme.fg("muted", "(renamed without content changes)"), width);
  }

  const flatLines = change.diff.hunks.flatMap((hunk) => hunk.lines);
  const highlights = config.wordHighlighting
    ? createInlineHighlightMap(flatLines)
    : new Map<DiffLine, import("./inline-diff.ts").InlineSpan[]>();
  const numberWidth = String(maxLineNumber(change)).length;
  const lines: string[] = [];

  for (let hunkIndex = 0; hunkIndex < change.diff.hunks.length; hunkIndex++) {
    if (hunkIndex > 0) lines.push(theme.fg("muted", "·".repeat(Math.min(3, width))));

    for (const line of change.diff.hunks[hunkIndex].lines) {
      const rendered = renderDiffLine(
        line,
        numberWidth,
        width,
        showLineNumbers,
        config,
        highlights,
        theme,
      );
      for (const row of rendered) lines.push(row);
    }
  }
  return lines;
}

function renderHeader(
  details: ApplyPatchDetails,
  width: number,
  theme: Theme,
): string {
  const change = details.changes.length === 1 ? details.changes[0] : undefined;
  let title: string;
  if (change) {
    const verb = change.type === "add"
      ? "Added"
      : change.type === "delete"
        ? "Deleted"
        : "Edited";
    title = `${theme.fg("toolTitle", theme.bold(verb))} ${theme.fg(
      "accent",
      getChangePath(change),
    )}`;
  } else if (details.stats.files > 1) {
    title = `${theme.fg("toolTitle", theme.bold("Edited"))} ${theme.fg(
      "toolOutput",
      `${details.stats.files} files`,
    )}`;
  } else {
    title = theme.fg("toolTitle", theme.bold("Applied patch"));
  }
  const text = [
    theme.fg("success", "•"),
    " ",
    title,
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
  showHeader = true,
): string[] {
  const layout = getUnifiedLayout(width, config);
  const lines = showHeader ? [renderHeader(details, layout.width, theme)] : [];
  if (details.changes.length === 0) return lines;

  const shortcut = keyText("app.tools.expand");
  const hint = shortcut ? `${shortcut} to ${expanded ? "collapse" : "expand"}` : "";
  if (layout.summaryOnly && !expanded) {
    if (hint) lines.push(...wrapTextWithAnsi(theme.fg("muted", hint), layout.width));
    return lines;
  }

  const contentWidth = Math.max(1, layout.width - visibleWidth(layout.indent));
  // Expansion is a complete view, never a second, larger preview. Measure the
  // fully wrapped rows so small uneven multi-file diffs also fit in full.
  const fullConfig = { ...config, longLines: "wrap" as const };
  const fullFiles = details.changes.map((change) => renderFileDiff(
    change, contentWidth, layout.showLineNumbers, fullConfig, theme,
  ));
  const totalBudget = Math.max(1, Math.floor(Math.min(config.collapsedLines, config.hardLineLimit)));
  const sizes = fullFiles.map((rows) => rows.length);
  const large = sizes.reduce((sum, size) => sum + size, 0) > totalBudget;
  // The optional truncate preference applies only to large collapsed previews.
  const files = !expanded && large && config.longLines === "truncate"
    ? details.changes.map((change) => renderFileDiff(
        change, contentWidth, layout.showLineNumbers, config, theme,
      ))
    : fullFiles;
  const budgets = allocateRows(files.map((rows) => rows.length), totalBudget);

  details.changes.forEach((change, index) => {
    if (details.changes.length > 1) {
      lines.push("");
      const label = `${getChangeLabel(change)} `;
      const heading = `${layout.indent}${theme.bold(label)}${formatStats(
        change.added,
        change.removed,
        theme,
      )}`;
      lines.push(truncateLine(heading, layout.width));
    }

    const rendered = files[index];
    const shown = expanded ? rendered : rendered.slice(0, budgets[index]);
    for (const line of shown) {
      // A two-column glyph cannot fit a one-column terminal. Only guard that
      // physical impossibility; ordinary expanded rows are already wrapped.
      lines.push(`${layout.indent}${visibleWidth(line) > contentWidth
        ? truncateLine(line, contentWidth) : line}`);
    }
    if (!expanded && rendered.length > shown.length) {
      lines.push(`${layout.indent}${truncateLine(theme.fg(
        "muted", `… ${rendered.length - shown.length} more diff rows`,
      ), contentWidth)}`);
    }
  });

  if ((large || layout.summaryOnly) && hint) {
    lines.push(...wrapTextWithAnsi(theme.fg("muted", hint), layout.width));
  }
  return lines;
}
