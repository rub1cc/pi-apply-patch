import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  DEFAULT_DIFF_RENDERER_CONFIG,
  type ApplyPatchDetails,
  type DiffRendererConfig,
} from "../types.ts";
import { renderUnifiedDiff } from "./unified.ts";

export interface CreateDiffComponentOptions {
  details: ApplyPatchDetails;
  /** Host expansion signal. Changes override the local view after initialization. */
  expanded: boolean;
  /** Initial local view; subsequent host expansion changes still take priority. */
  defaultExpanded?: boolean;
  /** Request a host redraw after a local click changes the view. */
  onToggle?: () => void;
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

export interface DiffComponent extends Component {
  toggleExpanded(): void;
}

class RichDiffComponent implements DiffComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private config: DiffRendererConfig;
  private expanded: boolean;

  constructor(private options: CreateDiffComponentOptions) {
    this.config = resolveConfig(options.config);
    this.expanded = options.expanded || options.defaultExpanded !== false;
  }

  setOptions(options: CreateDiffComponentOptions): this {
    if (options.expanded !== this.options.expanded) this.expanded = options.expanded;
    this.options = options;
    this.config = resolveConfig(options.config);
    this.invalidate();
    return this;
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.invalidate();
    this.options.onToggle?.();
  }

  handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
    if (event.type !== "click" || event.button !== "left") return;
    this.toggleExpanded();
    return { handled: true };
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    // The baseline renderer is intentionally unified-only. `view` and
    // `splitMinWidth` remain in the public config for the split-view milestone.
    const shortcut = keyText("app.tools.expand");
    const hint = [
      this.options.onToggle ? `click to ${this.expanded ? "collapse" : "expand"}` : "",
      shortcut ? `${shortcut} to toggle all` : "",
    ].filter(Boolean).join(" · ");
    this.cachedLines = renderUnifiedDiff(
      this.options.details,
      width,
      this.expanded,
      this.config,
      this.options.theme,
      this.options.showHeader,
      hint,
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
): DiffComponent {
  return lastComponent instanceof RichDiffComponent
    ? lastComponent.setOptions(options)
    : new RichDiffComponent(options);
}
