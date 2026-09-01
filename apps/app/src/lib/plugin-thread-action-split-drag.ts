import type { ExperimentalThreadActionSplitDragRequest } from "@get-bb/plugin-sdk";
import { useCallback, useEffect } from "react";
import { useStore } from "jotai";
import { useNavigate } from "react-router-dom";
import {
  countPanes,
  findPane,
  findPaneByContent,
  listPanes,
  MAX_PANES,
  replacePaneContent,
  setFocus,
  splitPane,
  type PaneContent,
  type SplitLayout,
} from "@/lib/split-layout";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import {
  beginSplitDrag,
  resolveSinglePaneSplitDragFallback,
  type SplitDropTarget,
  type SplitZone,
  type ZoneDecision,
} from "@/lib/split-drag";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useSplitWorkspaceActive } from "@/hooks/useSplitWorkspaceActive";
import { paneContentRoute } from "@/views/thread-detail/splitThreadNavigation";
import { runPluginPanelAction } from "@/components/plugin/PluginPanelActions";

type ThreadActionSplitDragHandler = (
  request: ExperimentalThreadActionSplitDragRequest,
) => boolean;

let handler: ThreadActionSplitDragHandler | null = null;

const BROWSER_ACTION_ID = "file-search-result-open-browser";
const TERMINAL_ACTION_ID = "file-search-result-start-terminal";
const DRAG_DISTANCE = 7;

export function beginPluginThreadActionSplitDrag(
  request: ExperimentalThreadActionSplitDragRequest,
): boolean {
  return handler?.(request) ?? false;
}

export function setPluginThreadActionSplitDragHandler(
  next: ThreadActionSplitDragHandler,
): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

function pluginActionIdentity(
  actionId: string,
): { pluginId: string; actionId: string } | null {
  const match = /^plugin-action:([^:]+):([^:]+)$/u.exec(actionId);
  return match?.[1] && match[2]
    ? { pluginId: match[1], actionId: match[2] }
    : null;
}

export function decideActionDrop({
  atMaxPanes,
  isOpen,
  title,
  zone,
}: {
  atMaxPanes: boolean;
  isOpen: boolean;
  title: string;
  zone: SplitZone;
}): ZoneDecision {
  if (isOpen) return { zone: "center", label: `Focus ${title}` };
  if (atMaxPanes) {
    return { zone: "center", label: `Open ${title} here` };
  }
  return {
    zone,
    label: zone === "center" ? `Open ${title} here` : `Split ${zone}`,
  };
}

export function applyThreadActionDrop(
  layout: SplitLayout,
  target: SplitDropTarget,
  content: PaneContent,
) {
  const existing = findPaneByContent(layout.root, content);
  if (findPane(layout.root, target.paneId) === null) return layout;
  if (existing !== null) {
    const updated =
      existing.content.kind === "thread-action" &&
      content.kind === "thread-action" &&
      (existing.content.title !== content.title ||
        existing.content.paramsJson !== content.paramsJson)
        ? replacePaneContent(layout, existing.paneId, content)
        : layout;
    return setFocus(updated, existing.paneId);
  }
  return target.zone === "center" || countPanes(layout.root) >= MAX_PANES
    ? replacePaneContent(layout, target.paneId, content)
    : splitPane(layout, target.paneId, target.zone, content);
}

function openActionContent(
  store: ReturnType<typeof useStore>,
  navigate: ReturnType<typeof useNavigate>,
  target: SplitDropTarget,
  content: PaneContent,
): boolean {
  const layout = store.get(splitLayoutAtom);
  if (layout === null) return false;
  const existing = findPaneByContent(layout.root, content);
  const next = applyThreadActionDrop(layout, target, content);
  if (next === layout && existing === null) return false;
  if (next !== layout) store.set(splitLayoutAtom, next);
  void navigate(paneContentRoute(content), {
    replace: existing !== null,
  });
  return true;
}

export function usePluginThreadActionSplitDrag(): void {
  const store = useStore();
  const navigate = useNavigate();
  const { threadPanelActions } = usePluginSlots();
  const isCompact = useIsCompactViewport();
  const splitWorkspaceActive = useSplitWorkspaceActive();
  const begin = useCallback<ThreadActionSplitDragHandler>(
    (request) => {
      if (isCompact || !splitWorkspaceActive) return false;
      const layout = store.get(splitLayoutAtom);
      if (layout === null) return false;
      const threadPane =
        listPanes(layout.root).find(
          (pane) =>
            pane.content.kind === "thread" &&
            pane.content.threadId === request.threadId,
        ) ?? null;
      if (threadPane === null || threadPane.content.kind !== "thread") {
        return false;
      }
      const pluginIdentity = pluginActionIdentity(request.actionId);
      const pluginAction =
        pluginIdentity === null
          ? null
          : (threadPanelActions.find(
              (action) =>
                action.pluginId === pluginIdentity.pluginId &&
                action.id === pluginIdentity.actionId,
            ) ?? null);
      const title =
        request.actionId === BROWSER_ACTION_ID
          ? "Browser"
          : request.actionId === TERMINAL_ACTION_ID
            ? "Terminal"
            : pluginAction?.title;
      if (title === undefined) return false;
      const content: PaneContent = {
        kind: "thread-action",
        projectId: threadPane.content.projectId,
        threadId: request.threadId,
        actionId: request.actionId,
        title,
        paramsJson: null,
      };
      const fallback = resolveSinglePaneSplitDragFallback(layout);
      beginSplitDrag({
        ghostLabel: title,
        sourceEl: request.source,
        ...(fallback === null ? {} : { fallback }),
        shouldEngage: (clientX, clientY) =>
          Math.hypot(clientX - request.startX, clientY - request.startY) >
          DRAG_DISTANCE,
        decide: (_paneId, zone) => {
          const current = store.get(splitLayoutAtom);
          return current === null
            ? null
            : decideActionDrop({
                atMaxPanes: countPanes(current.root) >= MAX_PANES,
                isOpen: findPaneByContent(current.root, content) !== null,
                title,
                zone,
              });
        },
        onDrop: (target) => {
          if (pluginAction === null) {
            openActionContent(store, navigate, target, content);
            return;
          }
          let accepted = false;
          runPluginPanelAction({
            action: pluginAction,
            threadId: request.threadId,
            openPluginPanel: (opened) => {
              if (accepted) return;
              accepted = openActionContent(store, navigate, target, {
                ...content,
                title: opened.title,
                paramsJson: opened.paramsJson,
              });
            },
          });
        },
      });
      return true;
    },
    [isCompact, navigate, splitWorkspaceActive, store, threadPanelActions],
  );
  useEffect(() => setPluginThreadActionSplitDragHandler(begin), [begin]);
}
