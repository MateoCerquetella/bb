// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { SplitLayout } from "@/lib/split-layout";
import { resolveSinglePaneSplitDragFallback } from "./singlePaneFallback";

function singlePaneLayout(): SplitLayout {
  return {
    root: {
      type: "pane",
      paneId: "pane-1",
      content: {
        kind: "thread",
        projectId: "project-1",
        threadId: "thread-1",
      },
    },
    focusedPaneId: "pane-1",
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("single-pane split drag fallback", () => {
  it("targets the visible thread column instead of the surrounding main area", () => {
    const main = document.createElement("main");
    const timeline = document.createElement("section");
    timeline.id = "thread-detail-timeline-panel";
    const rightPanel = document.createElement("aside");
    main.append(timeline, rightPanel);
    document.body.append(main);

    expect(resolveSinglePaneSplitDragFallback(singlePaneLayout())).toEqual({
      paneId: "pane-1",
      container: timeline,
    });
  });

  it("declines when the layout is split or the timeline target is absent", () => {
    expect(resolveSinglePaneSplitDragFallback(singlePaneLayout())).toBeNull();

    const timeline = document.createElement("section");
    timeline.id = "thread-detail-timeline-panel";
    document.body.append(timeline);
    const layout = singlePaneLayout();
    layout.root = {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        layout.root,
        {
          type: "pane",
          paneId: "pane-2",
          content: {
            kind: "thread",
            projectId: "project-1",
            threadId: "thread-2",
          },
        },
      ],
    };
    expect(resolveSinglePaneSplitDragFallback(layout)).toBeNull();
  });
});
