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
  UPDATE_FILE,
} from "./parser.ts";
import { createDiffComponent } from "./renderer/index.ts";
import { normalizeApplyPatchDetails } from "./renderer/normalize.ts";
import type { ApplyPatchDetails, DiffRendererConfig } from "./types.ts";

interface ApplyPatchRenderState {
  callComponent?: Box;
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

  const component = new Box(1, 1, (text: string) => text);
  state.callComponent = component;
  return component;
}

function renderPendingCall(component: Box, theme: Theme): Box {
  component.setBgFn((text: string) => theme.bg("toolPendingBg", text));
  component.clear();
  component.addChild(
    new Text(theme.fg("toolTitle", theme.bold("apply_patch")), 0, 0),
  );
  return component;
}

function renderError(component: Box, errorText: string, theme: Theme): Box {
  component.setBgFn((text: string) => theme.bg("toolErrorBg", text));
  component.clear();
  component.addChild(
    new Text(
      `${theme.fg("error", "✘ Failed to apply patch")}${
        errorText ? `\n${theme.fg("muted", errorText)}` : ""
      }`,
      0,
      0,
    ),
  );
  return component;
}

function renderSuccess(
  component: Box,
  details: ApplyPatchDetails | undefined,
  expanded: boolean,
  theme: Theme,
  config?: Partial<DiffRendererConfig>,
): Box {
  // Keep successful diffs transparent so the add/remove/context colors carry
  // the visual emphasis instead of a full-width tool background.
  component.setBgFn((text: string) => text);
  component.clear();

  if (!details) {
    component.addChild(new Text(theme.fg("success", "✓ Patch applied"), 0, 0));
    return component;
  }

  component.addChild(
    createDiffComponent({ details, expanded, config, theme }),
  );
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

    renderCall(_args, theme, context) {
      const state = context.state as ApplyPatchRenderState;
      return renderPendingCall(
        getCallComponent(state, context.lastComponent),
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

      if (state.callComponent) {
        if (context.isError) renderError(state.callComponent, errorText, theme);
        else {
          renderSuccess(
            state.callComponent,
            details,
            expanded,
            theme,
            rendererConfig,
          );
        }

        const resultComponent =
          (context.lastComponent as Container | undefined) ?? new Container();
        resultComponent.clear();
        return resultComponent;
      }

      if (context.isError) {
        return new Text(
          theme.fg("error", errorText || "Failed to apply patch"),
          0,
          0,
        );
      }

      return details
        ? createDiffComponent({
            details,
            expanded,
            config: rendererConfig,
            theme,
          })
        : new Text(theme.fg("success", "✓ Patch applied"), 0, 0);
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
