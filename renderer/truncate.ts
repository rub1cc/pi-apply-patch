import { truncateToWidth } from "@earendil-works/pi-tui";

export function truncateLine(value: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(value, width, "…");
}

export function distributeLineBudget(
  total: number,
  itemCount: number,
): number[] {
  if (itemCount <= 0) return [];
  const safeTotal = Math.max(itemCount, total);
  const base = Math.floor(safeTotal / itemCount);
  let remainder = safeTotal % itemCount;
  return Array.from({ length: itemCount }, () => base + (remainder-- > 0 ? 1 : 0));
}
