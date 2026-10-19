export interface UpdateChunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  /** Explicit unchanged lines, as [old-line index, new-line index] pairs. */
  contextLineIndices?: Array<[number, number]>;
  endOfFile: boolean;
}

export type PatchOperation =
  | {
      type: "add";
      path: string;
      content: string;
    }
  | {
      type: "delete";
      path: string;
    }
  | {
      type: "update";
      path: string;
      moveTo?: string;
      chunks: UpdateChunk[];
    };

export interface VirtualFile {
  content: string;
  mode: number;
}

export interface Snapshot {
  exists: boolean;
  content?: string;
  mode?: number;
}

export type DiffLineType = "context" | "add" | "remove";

export interface DiffLine {
  type: DiffLineType;
  oldLine?: number;
  newLine?: number;
  content: string;
  noNewlineAtEnd?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  stats: {
    added: number;
    removed: number;
  };
}

interface AppliedFileChangeBase {
  path: string;
  oldContent: string;
  newContent: string;
  added: number;
  removed: number;
  diff: ParsedDiff;
}

export interface AddedFileChange extends AppliedFileChangeBase {
  type: "add";
}

export interface DeletedFileChange extends AppliedFileChangeBase {
  type: "delete";
}

export interface UpdatedFileChange extends AppliedFileChangeBase {
  type: "update";
}

export interface MovedFileChange extends AppliedFileChangeBase {
  type: "move";
  moveTo: string;
}

export type AppliedFileChange =
  | AddedFileChange
  | DeletedFileChange
  | UpdatedFileChange
  | MovedFileChange;

export interface ApplyPatchDetails {
  changes: AppliedFileChange[];
  stats: {
    files: number;
    added: number;
    removed: number;
  };
}

export interface ApplyPatchResultData {
  details: ApplyPatchDetails;
}

export type DiffViewMode = "auto" | "unified" | "split";
export type LongLineMode = "wrap" | "truncate";

export interface DiffRendererConfig {
  view: DiffViewMode;
  splitMinWidth: number;
  lineNumbers: boolean;
  indicator: "bar" | "sign";
  longLines: LongLineMode;
  collapsedLines: number;
  /** @deprecated Ignored: expanded diffs always show all rows. */
  expandedLines: number;
  /** Caps collapsed previews only; never limits expanded diffs. */
  hardLineLimit: number;
  syntaxHighlighting: boolean;
  wordHighlighting: boolean;
}

export const DEFAULT_DIFF_RENDERER_CONFIG: Readonly<DiffRendererConfig> = {
  // Split view and syntax highlighting are intentionally reserved for the
  // next milestone. Keeping the complete shape makes the renderer API stable.
  view: "auto",
  splitMinWidth: 120,
  lineNumbers: true,
  indicator: "bar",
  longLines: "wrap",
  collapsedLines: 24,
  expandedLines: 120,
  hardLineLimit: 500,
  syntaxHighlighting: false,
  wordHighlighting: true,
};
