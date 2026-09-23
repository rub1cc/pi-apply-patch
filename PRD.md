PRD — Codex-Style apply_patch with Native Rich Diff Rendering for Pi

1. Overview

Build an improved apply_patch tool for Pi that keeps our existing Codex-compatible patch format and patch execution engine, but replaces the current diff presentation with a dedicated rich diff renderer adapted from the ideas/components used by pi-diff.

The renderer must be independent from pi-cc-extensions internals.

The resulting architecture should be:

LLM
 │
 │ apply_patch
 ▼
Codex-style patch parser
 │
 ▼
Patch preparation
 │
 ├── old content
 └── new content
 │
 ▼
Atomic patch execution
 │
 ▼
Structured change result
 │
 ▼
Rich Diff Renderer
 │
 ├── unified view
 ├── split view
 ├── line numbers
 ├── syntax highlighting
 ├── word-level highlighting
 ├── wrapping
 └── collapsed preview
 │
 ▼
Pi TUI

2. Problem

Our current apply_patch implementation successfully supports Codex-style patches:

*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

However, its rendering currently has problems.

Initially we used Pi's native renderDiff(). It worked reliably, but the presentation was relatively basic.

We then attempted to reuse pi-cc-extensions' rich diff renderer. This proved brittle because pi-cc's rendering implementation is tightly coupled to:

its global ToolExecutionComponent interception

its hover state

its config singleton

its rich-diff component markers

mouse interaction

collapse/expand handling

internal modules not designed as a stable public rendering API

When apply_patch was not explicitly excluded, pi-cc replaced our renderer with generic output:

✓ Apply Patch
  ↳ 3 lines returned • click to show more

Even when excluded, directly importing pi-cc's internal renderer introduces unnecessary coupling.

We need a renderer that belongs to the apply_patch tool itself.

3. Goal

Provide a first-class apply_patch experience comparable to a modern coding agent:

✓ Apply Patch 3 files (+14 -6)

src/auth/session.ts (+3 -1)

  41 │  export async function refresh() {
  42 │-   return oldRefresh(token);
  42 │+   return refreshSession(token);
  43 │+   await updateCache();
  44 │  }

At wider terminal widths:

src/auth/session.ts (+1 -1)

 OLD                                      │ NEW
──────────────────────────────────────────┼──────────────────────────────────────────
 42 │ oldRefresh(token);                  │ 42 │ refreshSession(token);

The renderer should provide the same experience whether a patch touches one file or ten.

4. Goals

Functional goals

Support rich rendering for all existing apply_patch operations:

Add File
Update File
Delete File
Move/Rename File
multiple hunks
multiple files

Provide:

unified diff

side-by-side diff

automatic layout selection

line numbers

add/remove statistics

syntax highlighting

word-level changed-token highlighting

context lines

long-line wrapping

large-diff truncation

collapsed/expanded views

terminal-width-aware rendering

multi-file summaries

Architectural goals

The renderer must:

be owned by our extension

not depend on pi-cc private modules

not modify Pi source

keep patch execution independent from presentation

work without pi-cc installed

continue working when pi-cc is installed

expose structured data that could later be reused by other frontends

5. Non-goals

This project will not initially implement:

a full replacement for pi-cc-extensions

a Git diff viewer

staging or committing files

interactive hunk acceptance/rejection

editing inside the diff view

GitHub review comments

web-based diff UI

arbitrary binary file diffs

image diffs

patch rollback UI

patch approval UI

sandboxing

Those can be considered separately.

6. Existing patch format

Do not replace our existing model-facing format.

The LLM should continue using:

*** Begin Patch
*** Update File: src/foo.ts
@@
 const before = true;
-oldCall();
+newCall();
*** End Patch

Supported operations remain:

*** Add File:
*** Update File:
*** Delete File:
*** Move to:
*** End of File

The renderer must be completely independent from this syntax.

7. Core design principle

Separate:

Patch Language

from:

Patch Execution

from:

Diff Representation

from:

Diff Rendering

So:

patch string
    ↓
parsePatch()
    ↓
PatchOperation[]
    ↓
preparePatch()
    ↓
AppliedChange[]
    ↓
DiffModel[]
    ↓
RichDiffComponent

This separation is important because we may replace the renderer later without modifying patch execution.

8. Proposed module structure

Move away from one giant apply_patch.ts.

Target:

apply-patch/
├── index.ts
│
├── parser.ts
├── executor.ts
├── filesystem.ts
├── types.ts
│
└── renderer/
    ├── index.ts
    ├── model.ts
    ├── diff.ts
    ├── parse.ts
    ├── unified.ts
    ├── split.ts
    ├── highlight.ts
    ├── inline-diff.ts
    ├── layout.ts
    ├── theme.ts
    ├── truncate.ts
    └── component.ts

index.ts registers the Pi tool.

9. Structured change model

applyPatch() should no longer primarily return strings such as:

Updated foo.ts
Added bar.ts

Instead return structured changes:

interface AppliedPatch {
  changes: AppliedFileChange[];
  added: number;
  removed: number;
}

type AppliedFileChange =
  | AddedFileChange
  | DeletedFileChange
  | UpdatedFileChange
  | MovedFileChange;

Example update:

interface UpdatedFileChange {
  type: "update";

  path: string;

  oldContent: string;
  newContent: string;

  added: number;
  removed: number;

  diff: ParsedDiff;
}

Move:

interface MovedFileChange {
  type: "move";

  path: string;
  moveTo: string;

  oldContent: string;
  newContent: string;

  added: number;
  removed: number;

  diff: ParsedDiff;
}

The renderer must consume this model rather than reparsing the model's original patch string.

10. Diff generation

Generate the display diff from:

oldContent
vs
newContent

not from the original apply_patch instructions.

Example:

createDiff(oldContent, newContent)

returns:

interface ParsedDiff {
  hunks: DiffHunk[];

  stats: {
    added: number;
    removed: number;
  };
}

Each line:

interface DiffLine {
  type: "context" | "add" | "remove";

  oldLine?: number;
  newLine?: number;

  content: string;
}

This gives rendering complete control over presentation.

11. Diff UI

Single file

Collapsed:

✓ Apply Patch src/auth.ts (+2 -1)

  42 │- return oldLogin();
  42 │+ return newLogin();
  43 │+ trackLogin();

  … 12 more diff lines

Expanded:

✓ Apply Patch src/auth.ts (+2 -1)

  39 │  export async function login() {
  40 │    const token = await getToken();
  41 │
  42 │-   return oldLogin();
  42 │+   return newLogin();
  43 │+   trackLogin();
  44 │  }

12. Multi-file UI

Header:

✓ Apply Patch 3 files (+17 -8)

Each file receives its own section:

src/auth.ts (+2 -1)

  ...

src/session.ts (+10 -5)

  ...

src/types.ts (+5 -2)

  ...

Do not combine unrelated files into one continuous diff block.

13. Add file presentation

Example:

✓ Apply Patch

Added src/auth/token.ts (+18 -0)

   1 │+ import ...
   2 │+
   3 │+ export function ...

All lines are additions.

14. Delete file presentation

Deleted src/legacy-auth.ts (+0 -26)

   1 │- import ...
   2 │-
   3 │- export function ...

15. Move / rename presentation

Pure rename:

src/old.ts → src/new.ts

If content also changes:

src/old.ts → src/new.ts (+2 -1)

  20 │- oldImplementation();
  20 │+ newImplementation();
  21 │+ additionalLine();

16. Diff view modes

Support:

type DiffViewMode =
  | "auto"
  | "unified"
  | "split";

unified

Always:

 42 │- old()
 42 │+ new()

split

 OLD                              │ NEW
──────────────────────────────────┼──────────────────────────────────
 42 │ old()                       │ 42 │ new()

auto

Use split when terminal width allows.

Otherwise unified.

Suggested starting threshold:

120 columns

but this should be configurable.

17. Narrow terminal fallback

Rendering must degrade gracefully.

Example decision:

width >= splitMinWidth
    → split

width >= 50
    → unified with line numbers

width >= 24
    → compact unified

very narrow
    → summary

Summary:

src/auth.ts (+4 -2)

Never allow malformed or unreadable layouts because the terminal is narrow.

18. Syntax highlighting

Use a syntax highlighter appropriate for terminal output.

The renderer should determine language from:

.ts   → TypeScript
.tsx  → TypeScript/TSX
.js   → JavaScript
.py   → Python
.rs   → Rust
.go   → Go
...

Unknown extensions should gracefully fall back to normal text.

Syntax highlighting must never block patch execution.

If highlighting fails:

render plain diff

not:

apply_patch fails

19. Intra-line highlighting

For:

const user = oldUser;

becoming:

const user = newUser;

highlight only:

oldUser
newUser

more strongly than the surrounding add/remove row.

Conceptually:

- const user = [oldUser];
+ const user = [newUser];

This should be calculated separately from syntax highlighting.

20. Theme behavior

Use Pi theme colors where possible.

Conceptual tokens:

diffAdded
diffRemoved
diffContext
diffAddedHighlight
diffRemovedHighlight
diffLineNumber
diffSeparator
diffMetadata

Do not hardcode a single dark-theme palette.

Must remain readable in:

Pi dark
Pi light
pi-cc dark
pi-cc light
custom Pi themes

21. Long lines

Config:

longLines: "wrap" | "truncate";

Default:

wrap

When wrapping:

123 │ const foo = thisIsAVeryLong...
    │ continuation...

Wrapped continuation lines must preserve the visual gutter.

22. Collapsed preview

Default:

24 rendered lines

rather than our current three-line preview.

When truncated:

… 38 more diff lines

Expanded mode displays more.

Suggested config:

collapsedLines: 24;
expandedLines: 120;

Large diffs should still have a hard safety ceiling.

23. Rendering performance

Large patches must not syntax-highlight thousands of invisible lines.

Pipeline:

determine visible line budget
        ↓
take relevant diff prefix
        ↓
syntax highlight only visible content
        ↓
render

Do not:

highlight 12,000 lines
        ↓
display first 24

Target:

collapsed render should remain responsive for very large patches

resizing should not recompute expensive data unnecessarily

24. Caching

Cache by:

file
diff identity
terminal width
view mode
theme
expanded state
renderer config

Example:

interface DiffRenderCacheKey {
  diffHash: string;
  width: number;
  mode: DiffViewMode;
  expanded: boolean;
  theme: string;
}

Re-render when any relevant value changes.

25. Pi tool rendering

Use:

renderCall()
renderResult()

from Pi.

Tool should own its presentation:

renderShell: "self"

The execution result should contain short model-facing text:

Patch applied successfully.
Updated 3 files.

while renderer-specific information lives under:

details

Do not dump the entire diff into model context unnecessarily.

26. details format

Target:

interface ApplyPatchDetails {
  changes: DiffChangeDetails[];

  stats: {
    files: number;
    added: number;
    removed: number;
  };
}

Example:

{
  changes: [
    {
      type: "update",
      path: "src/auth.ts",
      oldContent: "...",
      newContent: "...",
      added: 2,
      removed: 1,
      diff: {...}
    }
  ],

  stats: {
    files: 1,
    added: 2,
    removed: 1
  }
}

27. Pi-cc compatibility

When pi-cc-extensions is installed, users should configure:

{
  "excludeRenderers": [
    "apply_patch"
  ]
}

This ensures:

pi-cc
    ↓
does not replace apply_patch renderer

while all other tools remain styled by pi-cc.

Expected combination:

read        → pi-cc
grep        → pi-cc
bash        → pi-cc
edit        → pi-cc
write       → pi-cc

apply_patch → our renderer

The visual language should still be close enough that the tool does not feel foreign.

28. Configuration

Add optional configuration:

{
  "diff": {
    "view": "auto",
    "splitMinWidth": 120,

    "lineNumbers": true,

    "indicator": "bar",

    "longLines": "wrap",

    "collapsedLines": 24,
    "expandedLines": 120,

    "syntaxHighlighting": true,
    "wordHighlighting": true
  }
}

Defaults should work without any config file.

29. Renderer API

Keep the rendering engine reusable.

Example:

createDiffComponent({
  changes,
  expanded,
  config,
  theme
});

Do not make it depend directly on:

apply_patch parser
Pi ExtensionAPI
pi-cc state

The renderer should know only:

DiffModel
Theme
Width
Config

This would eventually allow the same renderer to be used by:

edit
write
apply_patch
git diff
PR review

30. Vendoring/adaptation strategy

Do not deep-import private pi-diff implementation files at runtime.

Instead:

identify the minimal rendering concepts/modules we need

adapt them into our extension

simplify them where appropriate

preserve required third-party license notices

document which portions were adapted

This prevents upstream package restructuring from breaking apply_patch.

31. Testing requirements

Patch behavior

add
update
delete
rename
rename + edit
multi-hunk
multi-file
CRLF
missing file
existing Add target
conflicting destination
path escape
rollback

Diff model

insert
delete
replacement
context
line numbering
statistics
multiple hunks
empty file
no trailing newline

Rendering

unified
split
auto mode
narrow width
wide width
wrapped lines
collapsed mode
expanded mode
dark theme
light theme
unknown language
syntax highlighting failure
very large diff

Golden/snapshot tests are recommended for rendered terminal output.

32. Acceptance criteria

The feature is complete when:

Existing Codex-style apply_patch syntax continues working unchanged.

Patch execution remains atomic/best-effort rollback equivalent to today's implementation.

Successful patches show a rich diff instead of generic output.

Multiple files show separate diff sections.

Added and removed line counts are accurate.

Unified mode works.

Split mode works at sufficient width.

auto switches appropriately.

Syntax highlighting works for common languages.

Intra-line changes are emphasized.

Large diffs are truncated before expensive rendering.

Collapsed/expanded rendering works correctly.

Terminal resizing produces a correct reflow.

Renderer works without pi-cc-extensions.

Renderer works alongside pi-cc when apply_patch is excluded from its renderer.

No pi-cc internal/private modules are imported.

33. Implementation phases

Phase 1 — Data model

Refactor current tool:

parser
executor
AppliedPatchDetails

No UI change yet.

Phase 2 — Basic renderer

Implement:

unified
line numbers
stats
multi-file
add/delete/move

Phase 3 — Highlighting

Add:

syntax highlighting
word-level diff

Phase 4 — Responsive layout

Add:

split
auto selection
wrapping
narrow layout

Phase 5 — Performance

Add:

render budgets
caching
large diff handling

Phase 6 — Polish

Validate:

pi-cc coexistence
dark/light themes
resize behavior
collapsed/expanded state

34. Final target

We want Pi to go from:

✓ Apply Patch
  ↳ 3 lines returned

or:

Done!
- Updated src/auth.ts

to something that feels like a first-class coding-agent operation:

✓ Apply Patch 2 files (+7 -3)

src/auth/session.ts (+4 -2)

   38 │  async function refresh(token) {
   39 │-   return legacyRefresh(token);
   39 │+   const session = await refreshSession(token);
   40 │+   updateCache(session);
   41 │+   return session;
   42 │  }

src/auth/types.ts (+3 -1)

   8 │- type SessionId = string;
   8 │+ export type SessionId = string;
   9 │+ export type RefreshToken = string;

while preserving the part we actually care about from Codex:

small tool call
+
powerful patch language
+
safe focused edits
+
excellent visual feedback

35. First implementation milestone

Refactor the existing apply_patch.ts without changing behavior, introduce the structured AppliedPatchDetails model, then implement a standalone unified renderer.

Do not start split view or Shiki until that baseline works.
