// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { SplitLayout } from "./types";
import {
  loadThreadSplitWorkspace,
  saveThreadSplitWorkspaces,
  splitLayoutContainsThread,
  threadIdsInSplitLayout,
  THREAD_WORKSPACES_STORAGE_KEY,
} from "./threadWorkspaces";

function layout(): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.4, 0.6],
      children: [
        {
          type: "pane",
          paneId: "pane-1",
          content: {
            kind: "thread",
            projectId: "project-1",
            threadId: "thread-1",
          },
        },
        {
          type: "pane",
          paneId: "pane-2",
          content: {
            kind: "thread-action",
            projectId: "project-1",
            threadId: "thread-1",
            actionId: "file-search-result-start-terminal",
            title: "Terminal",
            paramsJson: null,
          },
        },
      ],
    },
    focusedPaneId: "pane-2",
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe("thread split workspaces", () => {
  it("persists and restores pane geometry and Action panes by thread", () => {
    const value = layout();
    saveThreadSplitWorkspaces(value, 100);

    expect(loadThreadSplitWorkspace("thread-1")).toEqual(value);
    expect(loadThreadSplitWorkspace("thread-2")).toBeNull();
  });

  it("indexes every thread represented by a mixed workspace", () => {
    const value = layout();
    if (value.root.type !== "split") throw new Error("Expected split layout");
    value.root.children.push({
      type: "pane",
      paneId: "pane-3",
      content: {
        kind: "thread",
        projectId: "project-1",
        threadId: "thread-2",
      },
    });
    value.root.sizes = [0.3, 0.4, 0.3];

    expect(threadIdsInSplitLayout(value)).toEqual(["thread-1", "thread-2"]);
    expect(splitLayoutContainsThread(value, "thread-2")).toBe(true);
    saveThreadSplitWorkspaces(value, 200);
    expect(loadThreadSplitWorkspace("thread-2")).toEqual(value);
  });

  it("rejects malformed persisted workspace state", () => {
    window.localStorage.setItem(THREAD_WORKSPACES_STORAGE_KEY, "not json");
    expect(loadThreadSplitWorkspace("thread-1")).toBeNull();
  });
});
