// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyThreadActionDrop,
  beginPluginThreadActionSplitDrag,
  decideActionDrop,
  setPluginThreadActionSplitDragHandler,
} from "./plugin-thread-action-split-drag";
import {
  countPanes,
  findPaneByContent,
  type PaneContent,
  type SplitLayout,
} from "@/lib/split-layout";

const action: PaneContent = {
  kind: "thread-action",
  projectId: "p1",
  threadId: "thr_1",
  actionId: "plugin-action:tasks:taskboard",
  title: "Taskboard",
  paramsJson: null,
};

function layout(): SplitLayout {
  return {
    root: {
      type: "pane",
      paneId: "pane-1",
      content: {
        kind: "thread",
        projectId: "p1",
        threadId: "thr_1",
      },
    },
    focusedPaneId: "pane-1",
  };
}

describe("thread Action split drag", () => {
  it("uses sidebar-style edge, center, open, and pane-cap decisions", () => {
    expect(
      decideActionDrop({
        atMaxPanes: false,
        isOpen: false,
        title: "Taskboard",
        zone: "right",
      }),
    ).toEqual({ zone: "right", label: "Split right" });
    expect(
      decideActionDrop({
        atMaxPanes: false,
        isOpen: false,
        title: "Taskboard",
        zone: "center",
      }),
    ).toEqual({ zone: "center", label: "Open Taskboard here" });
    expect(
      decideActionDrop({
        atMaxPanes: true,
        isOpen: false,
        title: "Taskboard",
        zone: "left",
      }),
    ).toEqual({ zone: "center", label: "Open Taskboard here" });
    expect(
      decideActionDrop({
        atMaxPanes: false,
        isOpen: true,
        title: "Taskboard",
        zone: "left",
      }),
    ).toEqual({ zone: "center", label: "Focus Taskboard" });
  });

  it("splits, replaces, and focuses without duplicating an Action pane", () => {
    const split = applyThreadActionDrop(
      layout(),
      { paneId: "pane-1", zone: "right" },
      action,
    );
    expect(countPanes(split.root)).toBe(2);
    expect(findPaneByContent(split.root, action)?.paneId).toBe(
      split.focusedPaneId,
    );

    const focused = applyThreadActionDrop(
      split,
      { paneId: "pane-1", zone: "left" },
      action,
    );
    expect(countPanes(focused.root)).toBe(2);
    expect(focused.focusedPaneId).toBe(split.focusedPaneId);

    const refreshed = applyThreadActionDrop(
      focused,
      { paneId: "pane-1", zone: "left" },
      { ...action, paramsJson: `{"view":"today"}` },
    );
    expect(findPaneByContent(refreshed.root, action)?.content).toEqual({
      ...action,
      paramsJson: `{"view":"today"}`,
    });

    const replacement = applyThreadActionDrop(
      layout(),
      { paneId: "pane-1", zone: "center" },
      action,
    );
    expect(countPanes(replacement.root)).toBe(1);
    expect(findPaneByContent(replacement.root, action)?.paneId).toBe("pane-1");
  });

  it("exposes one active imperative host handler", () => {
    const source = document.createElement("button");
    const request = {
      actionId: "plugin-action:tasks:taskboard",
      threadId: "thr_1",
      source,
      startX: 10,
      startY: 20,
    };
    const clear = setPluginThreadActionSplitDragHandler(
      (received) => received === request,
    );
    expect(beginPluginThreadActionSplitDrag(request)).toBe(true);
    clear();
    expect(beginPluginThreadActionSplitDrag(request)).toBe(false);
  });
});
