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

Small diffs fit in the default 24-row preview, with unused per-file shares
redistributed to larger files. The budget counts visual diff rows (including
wrapped continuations), not headings. Larger diffs show a preview and the
configured Pi `app.tools.expand` shortcut, when bound.

Expanded output shows the entire diff with wrapping, even when `longLines` is
`"truncate"`. The legacy `expandedLines` option is ignored; `hardLineLimit`
limits only collapsed previews. Very narrow expanded views omit line numbers
and reduce gutters to leave room for content. Collapsed views below 24 columns
remain summary-only with an expansion hint when a shortcut is bound.

## Shared presentation API

`@rub1cc/pi-apply-patch/renderer` exports the diff component, normalization,
configuration, and rendering helpers without registering tools. The companion
`@rub1cc/pi-renderer` uses this entry point for built-in `edit` diffs, so both
tools share row backgrounds and expansion behavior. `showHeader: false` omits
the summary when the caller already provides an activity header.

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
