export interface InlineSpan {
  text: string;
  changed: boolean;
}

interface TokenEdit {
  type: "equal" | "add" | "remove";
  value: string;
}

const TOKEN_PATTERN = /\s+|[\p{L}\p{N}_$]+|./gu;
const MAX_TOKEN_MATRIX = 65_536;

function tokenize(value: string): string[] {
  return value.match(TOKEN_PATTERN) ?? [];
}

function mergeSpans(spans: InlineSpan[]): InlineSpan[] {
  const merged: InlineSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous?.changed === span.changed) previous.text += span.text;
    else merged.push({ ...span });
  }
  return merged;
}

function prefixSuffixDiff(oldValue: string, newValue: string): {
  oldSpans: InlineSpan[];
  newSpans: InlineSpan[];
} {
  let prefix = 0;
  const maxPrefix = Math.min(oldValue.length, newValue.length);
  while (prefix < maxPrefix && oldValue[prefix] === newValue[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < oldValue.length - prefix &&
    suffix < newValue.length - prefix &&
    oldValue[oldValue.length - 1 - suffix] ===
      newValue[newValue.length - 1 - suffix]
  ) {
    suffix++;
  }

  const spans = (value: string): InlineSpan[] => {
    const result: InlineSpan[] = [];
    if (prefix > 0) result.push({ text: value.slice(0, prefix), changed: false });
    const changedEnd = value.length - suffix;
    if (changedEnd > prefix) {
      result.push({ text: value.slice(prefix, changedEnd), changed: true });
    }
    if (suffix > 0) result.push({ text: value.slice(changedEnd), changed: false });
    return result;
  };

  return { oldSpans: spans(oldValue), newSpans: spans(newValue) };
}

function tokenEdits(oldTokens: string[], newTokens: string[]): TokenEdit[] {
  const rows = oldTokens.length + 1;
  const columns = newTokens.length + 1;
  const lcs = new Uint16Array(rows * columns);

  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex--) {
      const index = oldIndex * columns + newIndex;
      lcs[index] =
        oldTokens[oldIndex] === newTokens[newIndex]
          ? lcs[(oldIndex + 1) * columns + newIndex + 1] + 1
          : Math.max(
              lcs[(oldIndex + 1) * columns + newIndex],
              lcs[oldIndex * columns + newIndex + 1],
            );
    }
  }

  const edits: TokenEdit[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
    if (
      oldIndex < oldTokens.length &&
      newIndex < newTokens.length &&
      oldTokens[oldIndex] === newTokens[newIndex]
    ) {
      edits.push({ type: "equal", value: oldTokens[oldIndex] });
      oldIndex++;
      newIndex++;
    } else if (
      newIndex < newTokens.length &&
      (oldIndex === oldTokens.length ||
        lcs[oldIndex * columns + newIndex + 1] >=
          lcs[(oldIndex + 1) * columns + newIndex])
    ) {
      edits.push({ type: "add", value: newTokens[newIndex++] });
    } else {
      edits.push({ type: "remove", value: oldTokens[oldIndex++] });
    }
  }

  return edits;
}

export function createInlineDiff(
  oldValue: string,
  newValue: string,
): { oldSpans: InlineSpan[]; newSpans: InlineSpan[] } {
  if (oldValue === newValue) {
    const spans = [{ text: oldValue, changed: false }];
    return { oldSpans: spans, newSpans: spans.map((span) => ({ ...span })) };
  }

  const oldTokens = tokenize(oldValue);
  const newTokens = tokenize(newValue);
  if (oldTokens.length * newTokens.length > MAX_TOKEN_MATRIX) {
    return prefixSuffixDiff(oldValue, newValue);
  }

  const edits = tokenEdits(oldTokens, newTokens);
  return {
    oldSpans: mergeSpans(
      edits
        .filter((edit) => edit.type !== "add")
        .map((edit) => ({ text: edit.value, changed: edit.type === "remove" })),
    ),
    newSpans: mergeSpans(
      edits
        .filter((edit) => edit.type !== "remove")
        .map((edit) => ({ text: edit.value, changed: edit.type === "add" })),
    ),
  };
}
