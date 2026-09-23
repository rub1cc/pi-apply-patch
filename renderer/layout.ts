import type { DiffRendererConfig } from "../types.ts";

export interface UnifiedLayout {
  width: number;
  compact: boolean;
  summaryOnly: boolean;
  showLineNumbers: boolean;
  indent: string;
}

export function getUnifiedLayout(
  width: number,
  config: DiffRendererConfig,
): UnifiedLayout {
  const safeWidth = Math.max(1, width);
  return {
    width: safeWidth,
    compact: safeWidth < 50,
    summaryOnly: safeWidth < 24,
    showLineNumbers: config.lineNumbers && safeWidth >= 50,
    indent: safeWidth >= 30 ? "  " : "",
  };
}
