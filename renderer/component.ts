import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  DEFAULT_DIFF_RENDERER_CONFIG,
  type ApplyPatchDetails,
  type DiffRendererConfig,
} from "../types.ts";
import { renderUnifiedDiff } from "./unified.ts";

export interface CreateDiffComponentOptions {
  details: ApplyPatchDetails;
  expanded: boolean;
  config?: Partial<DiffRendererConfig>;
  theme: Theme;
}

function resolveConfig(
  config: Partial<DiffRendererConfig> | undefined,
): DiffRendererConfig {
  const resolved = { ...DEFAULT_DIFF_RENDERER_CONFIG, ...config };
  resolved.collapsedLines = Math.max(1, resolved.collapsedLines);
  resolved.expandedLines = Math.max(
    resolved.collapsedLines,
    resolved.expandedLines,
  );
  resolved.hardLineLimit = Math.max(1, resolved.hardLineLimit);
  return resolved;
}

class RichDiffComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly config: DiffRendererConfig;

  constructor(private readonly options: CreateDiffComponentOptions) {
    this.config = resolveConfig(options.config);
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    // The baseline renderer is intentionally unified-only. `view` and
    // `splitMinWidth` remain in the public config for the split-view milestone.
    this.cachedLines = renderUnifiedDiff(
      this.options.details,
      width,
      this.options.expanded,
      this.config,
      this.options.theme,
    );
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function createDiffComponent(
  options: CreateDiffComponentOptions,
): Component {
  return new RichDiffComponent(options);
}
