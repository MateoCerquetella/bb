import { useMemo, useState, type ReactNode } from "react";
import type { BrowserFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { createPluginPanelFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import {
  BrowserTabDeck,
  BrowserTabLifecycleObserver,
} from "@/components/secondary-panel/BrowserTabDeck";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { PluginPanelTabContent } from "@/components/plugin/PluginPanelActions";
import { useThread } from "@/hooks/queries/thread-queries";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import type { PaneContent } from "@/lib/split-layout";

const BROWSER_ACTION_ID = "file-search-result-open-browser";
const TERMINAL_ACTION_ID = "file-search-result-start-terminal";

interface ThreadActionPaneViewProps {
  content: Extract<PaneContent, { kind: "thread-action" }>;
  isFocused: boolean;
  paneId: string;
}

function pluginActionIdentity(
  actionId: string,
): { pluginId: string; actionId: string } | null {
  const match = /^plugin-action:([^:]+):([^:]+)$/u.exec(actionId);
  return match?.[1] && match[2]
    ? { pluginId: match[1], actionId: match[2] }
    : null;
}

export function ThreadActionPaneView({
  content,
  isFocused,
  paneId,
}: ThreadActionPaneViewProps) {
  const { data: thread } = useThread(content.threadId);
  const { data: environment } = useEnvironment(thread?.environmentId ?? "", {
    enabled:
      thread?.environmentId !== null && thread?.environmentId !== undefined,
  });
  const hosts = useHosts({
    enabled: environment !== undefined,
  });
  const canCreateTerminal =
    environment?.status === "ready" &&
    (hosts.data ?? []).some(
      (host) => host.id === environment.hostId && host.status === "connected",
    );
  let body: ReactNode;
  if (content.actionId === TERMINAL_ACTION_ID) {
    body = (
      <LazyThreadTerminalPanel
        autoCreate
        autoFocus={isFocused}
        canCreateTerminal={canCreateTerminal}
        isPanelOpen
        isPanelPersistedOpen
        panelStateId={`thread-action:${paneId}`}
        syncThreadId={null}
        target={{ kind: "thread", threadId: content.threadId }}
      />
    );
  } else if (content.actionId === BROWSER_ACTION_ID) {
    body = (
      <ThreadActionBrowserPane
        environmentId={thread?.environmentId ?? null}
        isFocused={isFocused}
        threadId={content.threadId}
      />
    );
  } else {
    const identity = pluginActionIdentity(content.actionId);
    if (identity === null) return null;
    const tab = createPluginPanelFixedPanelTab({
      actionId: identity.actionId,
      paramsJson: content.paramsJson,
      pluginId: identity.pluginId,
      title: content.title,
    });
    body = (
      <PluginPanelTabContent
        tab={tab}
        context={{ kind: "thread", threadId: content.threadId }}
      />
    );
  }
  return (
    <div
      data-thread-action-pane-action-id={content.actionId}
      data-thread-action-pane-thread-id={content.threadId}
      data-thread-action-pane-title={content.title}
      className="h-full min-h-0 min-w-0"
    >
      {body}
    </div>
  );
}

function ThreadActionBrowserPane({
  environmentId,
  isFocused,
  threadId,
}: {
  environmentId: string | null;
  isFocused: boolean;
  threadId: string;
}) {
  const tabId = `thread-action-browser:${threadId}`;
  const [state, setState] = useState({ title: null as string | null, url: "" });
  const [addressFocusRequest, setAddressFocusRequest] = useState<{
    requestId: number;
    tabId: string;
  } | null>({ requestId: 1, tabId });
  const tab = useMemo<BrowserFixedPanelTab>(
    () => ({
      environmentId,
      id: tabId,
      kind: "browser",
      title: state.title,
      url: state.url,
    }),
    [environmentId, state.title, state.url, tabId],
  );
  return (
    <>
      <BrowserTabLifecycleObserver browserTabs={[tab]} threadId={threadId} />
      <BrowserTabDeck
        browserTabs={[tab]}
        activeBrowserTabId={tab.id}
        addressFocusRequest={addressFocusRequest}
        onAddressFocusRequestConsumed={() => setAddressFocusRequest(null)}
        environmentId={environmentId}
        canShowNativeBrowserView={isFocused}
        canHandleBrowserCommands={isFocused}
        threadId={threadId}
        onUpdate={({ title, url }) => setState({ title, url })}
      />
    </>
  );
}
