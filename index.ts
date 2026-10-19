import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatch } from "./executor.ts";
import {
  ADD_FILE,
  BEGIN_PATCH,
  DELETE_FILE,
  END_PATCH,
  MOVE_TO,
  parsePatch,
  UPDATE_FILE,
} from "./parser.ts";
import { createDiffComponent, type DiffComponent } from "./renderer/index.ts";
import { getPatchLabel } from "./renderer/label.ts";
import { getChangePath } from "./renderer/model.ts";
import { normalizeApplyPatchDetails } from "./renderer/normalize.ts";
import type { ApplyPatchDetails, DiffRendererConfig } from "./types.ts";

interface ApplyPatchRenderState {
  callComponent?: Box;
  label?: string;
  diffComponent?: DiffComponent;
}

function getPendingLabel(args: { patch?: unknown } | undefined): string {
  if (typeof args?.patch !== "string") return getPatchLabel([]);
  try {
    // Parsing is pure: rendering must never prepare or execute the patch.
    return getPatchLabel(parsePatch(args.patch).map(getChangePath));
  } catch {
    return getPatchLabel([]);
  }
}

function getCallComponent(
  state: ApplyPatchRenderState,
  lastComponent: unknown,
): Box {
  if (lastComponent instanceof Box) {
    state.callComponent = lastComponent;
    return lastComponent;
  }
  if (state.callComponent) return state.callComponent;

  const component = new Box(0, 0, (text: string) => text);
  state.callComponent = component;
  return component;
}

function renderPendingCall(component: Box, label: string, theme: Theme): Box {
  component.setBgFn((text: string) => text);
  component.clear();
  component.addChild(
    new Text(
      `${theme.fg("accent", "•")} ${theme.fg("accent", theme.bold(label))}`,
      0,
      0,
    ),
  );
  return component;
}

function renderError(component: Box, label: string, errorText: string, theme: Theme): Box {
  component.setBgFn((text: string) => text);
  component.clear();
  const details = errorText
    ? `\n${errorText
        .split("\n")
        .map(
          (line, index) =>
            `${theme.fg("muted", index === 0 ? "  └ " : "    ")}${theme.fg(
              "error",
              line,
            )}`,
        )
        .join("\n")}`
    : "";
  component.addChild(
    new Text(
      `${theme.fg("error", "•")} ${theme.fg(
        "error",
        theme.bold(`${label} Failed`),
      )}${details}`,
      0,
      0,
    ),
  );
  return component;
}

function renderSuccess(
  component: Box,
  diffComponent: DiffComponent | undefined,
  theme: Theme,
  label: string,
): Box {
  // Keep successful diffs transparent so the add/remove/context colors carry
  // the visual emphasis instead of a full-width tool background.
  component.setBgFn((text: string) => text);
  component.clear();

  if (!diffComponent) {
    component.addChild(
      new Text(
        `${theme.fg("success", "•")} ${theme.fg("toolTitle", theme.bold(label))}`,
        0,
        0,
      ),
    );
    return component;
  }

  component.addChild(diffComponent);
  return component;
}

function getResultText(details: ApplyPatchDetails): string {
  if (details.stats.files !== 1) {
    return `Patch applied successfully.\nUpdated ${details.stats.files} files.`;
  }

  const change = details.changes[0];
  switch (change.type) {
    case "add":
      return `Patch applied successfully.\nAdded ${change.path}.`;
    case "delete":
      return `Patch applied successfully.\nDeleted ${change.path}.`;
    case "move":
      return `Patch applied successfully.\nMoved ${change.path} to ${change.moveTo}.`;
    case "update":
      return `Patch applied successfully.\nUpdated ${change.path}.`;
  }
}

export function registerApplyPatch(
  pi: ExtensionAPI,
  rendererConfig?: Partial<DiffRendererConfig>,
) {
  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    renderShell: "self",
    executionMode: "sequential",

    description:
      "Apply a Codex-style patch to files in the current working directory. " +
      "Supports Add File, Delete File, Update File, multiple hunks, and Move to.",

    promptSnippet: "Apply structured patches to one or more files",

    promptGuidelines: [
      "Prefer apply_patch for code edits instead of rewriting whole files.",
      `Patch text must begin with "${BEGIN_PATCH}" and end with "${END_PATCH}".`,
      `Use "${ADD_FILE}<path>", "${UPDATE_FILE}<path>", or "${DELETE_FILE}<path>" for each file operation.`,
      "For added files, prefix every content line with +.",
      "For updates, prefix context lines with a space, removed lines with -, and added lines with +.",
      `Use "${MOVE_TO}<path>" immediately after an Update File header to rename a file.`,
    ],

    parameters: Type.Object({
      patch: Type.String({
        minLength: 1,
        description:
          "Codex-style patch text beginning with *** Begin Patch and ending with *** End Patch.",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Patch application cancelled");

      onUpdate?.({
        content: [{ type: "text", text: "Applying patch..." }],
        details: undefined,
      });

      const result = await applyPatch(ctx.cwd, params.patch, signal);
      return {
        content: [{ type: "text", text: getResultText(result.details) }],
        details: result.details,
      };
    },

    renderCall(args, theme, context) {
      const state = context.state as ApplyPatchRenderState;
      state.label = getPendingLabel(args);
      return renderPendingCall(
        getCallComponent(state, context.lastComponent),
        state.label,
        theme,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return (
          (context.lastComponent as Container | undefined) ?? new Container()
        );
      }

      const state = context.state as ApplyPatchRenderState;
      const label = state.label ?? getPendingLabel(context.args);
      const errorText = context.isError
        ? result.content
            .filter((item) => item.type === "text")
            .map((item) => ("text" in item ? item.text : ""))
            .filter(Boolean)
            .join("\n")
        : "";
      const details = context.isError
        ? undefined
        : normalizeApplyPatchDetails(result.details);
      state.diffComponent = details ? createDiffComponent({
        details,
        expanded,
        config: rendererConfig,
        theme,
        onToggle: context.invalidate,
      }, state.diffComponent) : undefined;

      if (state.callComponent) {
        if (context.isError) renderError(state.callComponent, label, errorText, theme);
        else {
          renderSuccess(
            state.callComponent,
            state.diffComponent,
            theme,
            label,
          );
        }

        const resultComponent =
          (context.lastComponent as Container | undefined) ?? new Container();
        resultComponent.clear();
        return resultComponent;
      }

      if (context.isError) {
        return renderError(new Box(0, 0, (text: string) => text), label, errorText, theme);
      }

      return state.diffComponent
        ? state.diffComponent
        : new Text(
            `${theme.fg("success", "•")} ${theme.fg("toolTitle", theme.bold(label))}`,
            0,
            0,
          );
    },
  });
}

export default registerApplyPatch;

export type {
  AppliedFileChange,
  ApplyPatchDetails,
  DiffHunk,
  DiffLine,
  DiffRendererConfig,
  ParsedDiff,
} from "./types.ts";
export { applyPatch } from "./executor.ts";
export { parsePatch } from "./parser.ts";
export { createDiff, createDiffComponent } from "./renderer/index.ts";
