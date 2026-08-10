// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SidebarThreadSelectionProvider,
  useSidebarThreadSelection,
} from "./SidebarThreadSelection";

const { requestDeleteMany } = vi.hoisted(() => ({
  requestDeleteMany: vi.fn(),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({ requestDeleteMany }),
}));

function SelectionRow({ id }: { id: string }) {
  const selection = useSidebarThreadSelection();
  return (
    <button
      type="button"
      data-sidebar-thread-id={id}
      onClick={(event) => selection.handleThreadClick(event, id)}
    >
      {id}
    </button>
  );
}

function renderSelection() {
  render(
    <div data-sidebar="sidebar">
      <SidebarThreadSelectionProvider>
        <SelectionRow id="thread-1" />
        <SelectionRow id="thread-2" />
        <SelectionRow id="thread-3" />
      </SidebarThreadSelectionProvider>
    </div>,
  );
}

describe("SidebarThreadSelectionProvider", () => {
  afterEach(() => {
    cleanup();
    requestDeleteMany.mockReset();
  });

  it("selects a range, clears it on a normal click, and deletes it", () => {
    renderSelection();

    fireEvent.click(screen.getByRole("button", { name: "thread-1" }));
    fireEvent.click(screen.getByRole("button", { name: "thread-3" }), {
      shiftKey: true,
    });

    expect(screen.getByText("3 selected")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "thread-1" }));
    expect(screen.queryByText("3 selected")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "thread-3" }), {
      shiftKey: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(requestDeleteMany).toHaveBeenCalledWith(
      ["thread-1", "thread-2", "thread-3"],
      expect.any(Function),
    );
    expect(screen.getByText("3 selected")).toBeDefined();

    act(() => requestDeleteMany.mock.calls[0]?.[1]());
    expect(screen.queryByText("3 selected")).toBeNull();
  });
});
