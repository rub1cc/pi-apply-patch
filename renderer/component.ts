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
  /** Hide the summary when the caller already renders its own activity header. */
  showHeader?: boolean;
  config?: Partial<DiffRendererConfig>;
  theme: Theme;
}

function resolveConfig(
  config: Partial<DiffRendererConfig> | undefined,
): DiffRendererConfig {
  const resolved = { ...DEFAULT_DIFF_RENDERER_CONFIG, ...config };
  resolved.collapsedLines = Math.max(1, resolved.collapsedLines);
  // expandedLines is retained only for API compatibility; expansion is uncapped.
  resolved.hardLineLimit = Math.max(1, resolved.hardLineLimit);
  return resolved;
}

class RichDiffComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private config: DiffRendererConfig;

  constructor(private options: CreateDiffComponentOptions) {
    this.config = resolveConfig(options.config);
  }

  setOptions(options: CreateDiffComponentOptions): this {
    this.options = options;
    this.config = resolveConfig(options.config);
    this.invalidate();
    return this;
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
      this.options.showHeader,
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
  lastComponent?: Component,
): Component {
  return lastComponent instanceof RichDiffComponent
    ? lastComponent.setOptions(options)
    : new RichDiffComponent(options);
}
