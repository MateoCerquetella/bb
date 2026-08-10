import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";

interface SidebarThreadSelectionContextValue {
  handleThreadClick(event: MouseEvent<HTMLElement>, threadId: string): boolean;
  selectedThreadIds: ReadonlySet<string>;
}

const EMPTY_SELECTION = new Set<string>();

const SidebarThreadSelectionContext =
  createContext<SidebarThreadSelectionContextValue>({
    handleThreadClick: () => false,
    selectedThreadIds: EMPTY_SELECTION,
  });

export function useSidebarThreadSelection(): SidebarThreadSelectionContextValue {
  return useContext(SidebarThreadSelectionContext);
}

export function SidebarThreadSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { requestDeleteMany } = useThreadActions();
  const [selectedThreadIds, setSelectedThreadIds] =
    useState<Set<string>>(EMPTY_SELECTION);
  const anchorThreadIdRef = useRef<string | null>(null);

  function clear() {
    anchorThreadIdRef.current = null;
    setSelectedThreadIds(EMPTY_SELECTION);
  }

  const handleThreadClick = useCallback(
    (event: MouseEvent<HTMLElement>, threadId: string): boolean => {
      if (!event.shiftKey) {
        anchorThreadIdRef.current = threadId;
        setSelectedThreadIds((current) =>
          current.size ? EMPTY_SELECTION : current,
        );
        return false;
      }

      event.preventDefault();
      event.stopPropagation();

      const rows = event.currentTarget
        .closest('[data-sidebar="sidebar"]')
        ?.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]");
      const visibleThreadIds = Array.from(
        rows ?? [],
        (row) => row.dataset.sidebarThreadId!,
      );
      const anchorId = anchorThreadIdRef.current ?? threadId;
      anchorThreadIdRef.current = anchorId;
      const anchorIndex = visibleThreadIds.indexOf(anchorId);
      const targetIndex = visibleThreadIds.indexOf(threadId);
      const selectedRange =
        anchorIndex < 0 || targetIndex < 0
          ? [threadId]
          : visibleThreadIds.slice(
              Math.min(anchorIndex, targetIndex),
              Math.max(anchorIndex, targetIndex) + 1,
            );
      setSelectedThreadIds(
        (current) => new Set([...current, ...selectedRange]),
      );
      return true;
    },
    [],
  );

  const value = useMemo<SidebarThreadSelectionContextValue>(
    () => ({
      handleThreadClick,
      selectedThreadIds,
    }),
    [handleThreadClick, selectedThreadIds],
  );

  return (
    <SidebarThreadSelectionContext.Provider value={value}>
      {children}
      {selectedThreadIds.size ? (
        <div className="shrink-0 px-2 pb-2 group-data-[collapsible=icon]:hidden">
          <div
            role="toolbar"
            aria-label="Selected thread actions"
            className="flex h-10 items-center gap-1 rounded-lg border border-sidebar-border bg-sidebar-accent/90 p-1 pl-3 shadow-sm backdrop-blur-sm"
          >
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-accent-foreground">
              {selectedThreadIds.size} selected
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Clear selection"
              className="size-8 text-muted-foreground hover:text-sidebar-foreground"
              onClick={clear}
            >
              <Icon name="X" className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-8 gap-1.5 px-2.5"
              onClick={() => requestDeleteMany([...selectedThreadIds], clear)}
            >
              <Icon name="Trash2" className="size-3.5" />
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </SidebarThreadSelectionContext.Provider>
  );
}
