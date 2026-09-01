// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaneContent } from "@/lib/split-layout";
import { ThreadActionPaneView } from "./ThreadActionPaneView";

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: { environmentId: "environment-1" } }),
}));

vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({
    data: { hostId: "host-1", status: "ready" },
  }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [{ id: "host-1", status: "connected" }] }),
}));

vi.mock("@/components/secondary-panel/lazySecondaryPanelComponents", () => ({
  LazyThreadTerminalPanel: () => <div data-testid="terminal-pane" />,
}));

vi.mock("@/components/secondary-panel/BrowserTabDeck", () => ({
  BrowserTabDeck: () => <div data-testid="browser-pane" />,
  BrowserTabLifecycleObserver: () => null,
}));

vi.mock("@/components/plugin/PluginPanelActions", () => ({
  PluginPanelTabContent: () => <div data-testid="plugin-pane" />,
}));

afterEach(cleanup);

describe("ThreadActionPaneView", () => {
  it("exposes the thread and Action identity on the main pane content", () => {
    const content: Extract<PaneContent, { kind: "thread-action" }> = {
      kind: "thread-action",
      projectId: "project-1",
      threadId: "thread-1",
      actionId: "file-search-result-start-terminal",
      title: "Terminal",
      paramsJson: null,
    };

    const { container } = render(
      <ThreadActionPaneView content={content} isFocused paneId="pane-2" />,
    );

    const marker = container.firstElementChild;
    expect(marker).toBeInstanceOf(HTMLElement);
    expect(marker?.getAttribute("data-thread-action-pane-action-id")).toBe(
      content.actionId,
    );
    expect(marker?.getAttribute("data-thread-action-pane-thread-id")).toBe(
      content.threadId,
    );
    expect(marker?.getAttribute("data-thread-action-pane-title")).toBe(
      content.title,
    );
    expect(screen.getByTestId("terminal-pane")).toBeTruthy();
  });
});
