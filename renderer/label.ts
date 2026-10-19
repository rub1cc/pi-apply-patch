import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function getPatchSummary(paths: string[]): string {
  if (paths.length > 1) return `${paths.length} files`;
  if (paths.length === 0) return "";
  return stripTerminalSequences(paths[0])
    .replace(/[\r\n\t\u2028\u2029]/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function getPatchLabel(paths: string[]): string {
  return `Patch(${getPatchSummary(paths)})`;
}
