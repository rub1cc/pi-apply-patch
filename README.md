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
- Rejects path traversal and symlink escapes.
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

## Development

```bash
bun test
npm pack --dry-run
```

Pi loads the TypeScript source directly; no build step is required.
