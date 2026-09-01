import { listPanes, type SplitLayout } from "@/lib/split-layout";
import type { SplitDragFallbackTarget } from "./splitDragSession";

const THREAD_TIMELINE_PANEL_SELECTOR = "#thread-detail-timeline-panel";

export function resolveSinglePaneSplitDragFallback(
  layout: SplitLayout | null,
): SplitDragFallbackTarget | null {
  if (layout === null) return null;
  const panes = listPanes(layout.root);
  const onlyPane = panes[0];
  if (panes.length !== 1 || onlyPane === undefined) return null;
  const container = document.querySelector<HTMLElement>(
    THREAD_TIMELINE_PANEL_SELECTOR,
  );
  return container === null
    ? null
    : { paneId: onlyPane.paneId, container };
}
