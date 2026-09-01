// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  shouldMountTerminalViewForPanel,
  useThreadTerminalController,
  type ThreadTerminalControllerArgs,
} from "./useThreadTerminalController";
import { resetFixedPanelTabsStateForTest } from "@/lib/fixed-panel-tabs";
import {
  createEmptyFixedPanelTabsState,
  createTerminalFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
  serializeFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs-state";

vi.mock("@/lib/sdk", () => ({
  sdk: { terminals: { create: vi.fn(), list: vi.fn() } },
}));

const session: TerminalSession = {
  id: "term_1",
  threadId: "thr_1",
  environmentId: "env_1",
  hostId: "host_1",
  title: "Terminal",
  initialCwd: "/workspace",
  cols: 100,
  rows: 30,
  status: "running",
  exitCode: null,
  closeReason: null,
  createdAt: 1,
  updatedAt: 1,
  lastUserInputAt: null,
};

interface PanelVisibility {
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
}

function controllerArgs(
  visibility: PanelVisibility,
): ThreadTerminalControllerArgs {
  return {
    canCreateTerminal: true,
    isPanelOpen: visibility.isPanelOpen,
    isPanelPersistedOpen: visibility.isPanelPersistedOpen,
    syncThreadId: null,
    target: { kind: "thread", threadId: "thr_1" },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  resetFixedPanelTabsStateForTest();
});

describe("shouldMountTerminalViewForPanel", () => {
  it("mounts only for an open panel or a hidden panel this client already opened", () => {
    expect(
      shouldMountTerminalViewForPanel({
        hasPanelOpened: false,
        isPanelOpen: true,
        isPanelPersistedOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldMountTerminalViewForPanel({
        hasPanelOpened: false,
        isPanelOpen: false,
        isPanelPersistedOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldMountTerminalViewForPanel({
        hasPanelOpened: true,
        isPanelOpen: false,
        isPanelPersistedOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldMountTerminalViewForPanel({
        hasPanelOpened: true,
        isPanelOpen: false,
        isPanelPersistedOpen: false,
      }),
    ).toBe(false);
  });
});

describe("useThreadTerminalController terminal view mounting", () => {
  it("creates one terminal when an Action pane requests automatic startup", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [] });
    vi.mocked(sdk.terminals.create).mockResolvedValue(session);
    const { wrapper } = createQueryClientTestHarness();
    renderHook(
      () =>
        useThreadTerminalController({
          ...controllerArgs({
            isPanelOpen: true,
            isPanelPersistedOpen: true,
          }),
          autoCreate: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.terminals.create).toHaveBeenCalledTimes(1);
    });
    expect(sdk.terminals.create).toHaveBeenCalledWith({
      cols: 100,
      rows: 30,
      scope: { kind: "thread", threadId: "thr_1" },
    });
  });

  it("creates a terminal when a reused Action pane remembers a stale terminal", async () => {
    const panelStateId = "thread-action:pane-2";
    const staleTab = createTerminalFixedPanelTab({
      terminalId: "term_stale",
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId: panelStateId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt: Date.now(),
          secondary: {
            activeTabId: staleTab.id,
            isOpen: true,
            tabs: [staleTab],
          },
        }),
      }),
    );
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [] });
    vi.mocked(sdk.terminals.create).mockResolvedValue(session);
    const { wrapper } = createQueryClientTestHarness();

    renderHook(
      () =>
        useThreadTerminalController({
          ...controllerArgs({
            isPanelOpen: true,
            isPanelPersistedOpen: true,
          }),
          autoCreate: true,
          panelStateId,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.terminals.create).toHaveBeenCalledTimes(1);
    });
  });

  it("does not mount a persisted-open terminal the panel never showed", () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [session] });
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadTerminalController(
          controllerArgs({ isPanelOpen: false, isPanelPersistedOpen: true }),
        ),
      { wrapper },
    );

    expect(result.current.shouldMountTerminalView).toBe(false);
    expect(sdk.terminals.list).not.toHaveBeenCalled();
  });

  it("keeps the view mounted across a compact close and unmounts once persisted state closes", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [session] });
    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      (visibility: PanelVisibility) =>
        useThreadTerminalController(controllerArgs(visibility)),
      {
        wrapper,
        initialProps: { isPanelOpen: true, isPanelPersistedOpen: true },
      },
    );

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe(session.id);
    });
    expect(result.current.shouldMountTerminalView).toBe(true);

    rerender({ isPanelOpen: false, isPanelPersistedOpen: true });
    expect(result.current.shouldMountTerminalView).toBe(true);
    expect(result.current.activeSession?.id).toBe(session.id);

    rerender({ isPanelOpen: false, isPanelPersistedOpen: false });
    expect(result.current.shouldMountTerminalView).toBe(false);

    rerender({ isPanelOpen: false, isPanelPersistedOpen: true });
    expect(result.current.shouldMountTerminalView).toBe(false);
    rerender({ isPanelOpen: true, isPanelPersistedOpen: true });
    expect(result.current.shouldMountTerminalView).toBe(true);
  });
});
