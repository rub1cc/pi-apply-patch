# @rub1cc/pi-apply-patch

A Pi extension that provides a Codex-compatible `apply_patch` tool with native,
width-aware rich diff rendering.

## Install

```bash
pi install npm:@rub1cc/pi-apply-patch
```

Try it for one invocation without adding it to settings:

```bash
pi -e npm:@rub1cc/pi-apply-patch
```

## Features

- Supports `Add File`, `Update File`, `Delete File`, and `Move to` patch headers.
- Validates multi-file patches before committing, with best-effort rollback on failure.
- Holds Pi's shared file-mutation queues for all affected paths through rollback.
- Respects the process umask for new files and preserves existing file permissions.
- Rejects path traversal, leaf symlinks (including dangling links), and symlink escapes.
- Preserves UTF-8 BOMs, original context text, and per-line LF/CRLF/CR terminators.
- Plans update hunks against the original file; addition-only hunks append at EOF.
- Renders unified diffs with syntax and inline change highlighting.
- Supports compact previews and Pi's native expanded tool view.

## Diff presentation

Tool headers use a small `•` dot and `Patch(path)` labels for one file, `Patch(N files)`
for multiple files, and `Patch()` when paths are unknown. Moves retain the
source-to-destination path display. Pending labels are accented and summarize
only parsed patch paths, without filesystem access; incomplete or invalid patches
fall back to `Patch()`. Failed labels are red with a `Failed` suffix. Completed
headers use the normal title styling and retain the add/remove statistics.
Displayed header paths have terminal sequences and control characters removed;
patch bodies are never included in headers. The registered tool remains
`apply_patch`, with unchanged arguments, execution, and model-facing result text.

Diffs show all changed hunks inline by default, including long wrapped lines.
In fullscreen, click the diff header or body to collapse it to a 24-row preview,
then click again to show every row. The local view survives redraws and resizing.
Pi's global tool-expansion shortcut still controls all tool views: expanding all
shows full diffs, and subsequently collapsing all selects the compact preview.
The first global expansion may leave an already-open diff unchanged.

Compact previews redistribute unused per-file shares to larger files. The budget
counts visual diff rows (including wrapped continuations), not headings.

Expanded output shows the entire diff with wrapping, even when `longLines` is
`"truncate"`. The legacy `expandedLines` option is ignored; `hardLineLimit`
limits only collapsed previews. Very narrow expanded views omit line numbers
and reduce gutters to leave room for content. Collapsed views below 24 columns
remain summary-only with a toggle hint.

## Shared presentation API

`@rub1cc/pi-apply-patch/renderer` exports the diff component, normalization,
configuration, and rendering helpers without registering tools. The companion
`@rub1cc/pi-renderer` uses this entry point for built-in `edit` diffs, so both
tools share row backgrounds and expansion behavior. `showHeader: false` omits
the summary when the caller already provides an activity header.
`createDiffComponent()` starts fully open unless `defaultExpanded: false` is
specified. Its `expanded` option tracks host expansion changes, `onToggle`
requests a redraw after a local click, and the returned component exposes
`toggleExpanded()`. Low-level `renderUnifiedDiff()` still follows its explicit
expanded argument.

## Filesystem safety and failure semantics

Leaf symlinks are rejected rather than followed, so deleting a link cannot
silently delete its target. Canonical paths are checked again after waiting for
mutation queues and immediately around filesystem operations. Snapshot opens
use `O_NOFOLLOW`; temporary writes use exclusive creation.

These are defense-in-depth checks, not a descriptor-relative filesystem sandbox:
an unrelated process can still race directory swaps between checks and operations.
Use OS-level sandboxing when the working tree can be modified by hostile processes.

Rollback restores only attempted mutations. If restoration fails, the thrown
`PatchRollbackError` retains the original cause and lists failed paths and reasons;
files may remain changed. Newly created directories may remain even after a
successful rollback. Multi-file patches are not filesystem transactions.

Updates terminate surviving unterminated lines using the first existing line
ending (LF for files without one). Pure moves preserve content byte-for-byte.
Empty additions and updates deleting all lines produce empty files.

## Development

```bash
bun test
npm pack --dry-run
```

Pi loads the TypeScript source directly; no build step is required.

## Releases

See [RELEASING.md](RELEASING.md) for npm trusted publishing and tag-based releases
with `npm version`.
