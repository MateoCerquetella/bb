import { z } from "zod";
import { listPanes } from "./ops";
import { deserializeSplitLayout, serializeSplitLayout } from "./persistence";
import type { SplitLayout } from "./types";

export const THREAD_WORKSPACES_STORAGE_KEY = "bb.splitLayout.byThread";

const MAX_THREAD_WORKSPACES = 100;
const MAX_SERIALIZED_LAYOUT_LENGTH = 256_000;

const storedWorkspaceSchema = z
  .object({
    layout: z.string().max(MAX_SERIALIZED_LAYOUT_LENGTH),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const storedWorkspacesSchema = z
  .object({
    version: z.literal(1),
    workspaces: z.record(z.string().min(1).max(128), storedWorkspaceSchema),
  })
  .strict();

type StoredWorkspaces = z.infer<typeof storedWorkspacesSchema>;

const EMPTY_STORED_WORKSPACES: StoredWorkspaces = {
  version: 1,
  workspaces: {},
};

function readStoredWorkspaces(): StoredWorkspaces {
  if (typeof window === "undefined") return EMPTY_STORED_WORKSPACES;
  try {
    const raw = window.localStorage.getItem(THREAD_WORKSPACES_STORAGE_KEY);
    if (raw === null) return EMPTY_STORED_WORKSPACES;
    const parsed: unknown = JSON.parse(raw);
    const result = storedWorkspacesSchema.safeParse(parsed);
    return result.success ? result.data : EMPTY_STORED_WORKSPACES;
  } catch {
    return EMPTY_STORED_WORKSPACES;
  }
}

function writeStoredWorkspaces(value: StoredWorkspaces): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      THREAD_WORKSPACES_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    return;
  }
}

export function threadIdsInSplitLayout(layout: SplitLayout): string[] {
  return [
    ...new Set(
      listPanes(layout.root).flatMap((pane) => {
        const content = pane.content;
        return content.kind === "thread" || content.kind === "thread-action"
          ? [content.threadId]
          : [];
      }),
    ),
  ];
}

export function splitLayoutContainsThread(
  layout: SplitLayout,
  threadId: string,
): boolean {
  return threadIdsInSplitLayout(layout).includes(threadId);
}

export function loadThreadSplitWorkspace(threadId: string): SplitLayout | null {
  const stored = readStoredWorkspaces().workspaces[threadId];
  if (stored === undefined) return null;
  const layout = deserializeSplitLayout(stored.layout);
  return layout !== null && splitLayoutContainsThread(layout, threadId)
    ? layout
    : null;
}

export function saveThreadSplitWorkspaces(
  layout: SplitLayout,
  now = Date.now(),
): void {
  const threadIds = threadIdsInSplitLayout(layout);
  if (threadIds.length === 0) return;
  const current = readStoredWorkspaces();
  const serialized = serializeSplitLayout(layout);
  const workspaces = { ...current.workspaces };
  for (const threadId of threadIds) {
    workspaces[threadId] = { layout: serialized, updatedAt: now };
  }
  const retained = Object.fromEntries(
    Object.entries(workspaces)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_THREAD_WORKSPACES),
  );
  writeStoredWorkspaces({ version: 1, workspaces: retained });
}
