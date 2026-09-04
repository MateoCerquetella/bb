import { describe, expect, it } from "vitest";
import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  turnScope,
  type Thread,
} from "@bb/domain";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  listEvents,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import {
  buildThreadConversationOutline,
  buildThreadTimeline,
} from "../../../src/services/threads/timeline.js";

function setup(): { db: DbConnection; thread: Thread } {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, thread };
}

describe("timeline context-clear epochs", () => {
  it("shows only the latest completed epoch while retaining older events", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Old visible response" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/contextWindowUsage/updated",
        scope: turnScope("old-turn"),
        providerThreadId: "provider-old",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          contextWindowUsage: {
            estimated: false,
            modelContextWindow: 100_000,
            usedTokens: 9_000,
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "system/operation",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          operation: THREAD_CONTEXT_CLEAR_OPERATION,
          operationId: "failed-clear",
          status: "failed",
          message: "Clear failed",
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Still visible before success" }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "system/operation",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          operation: THREAD_CONTEXT_CLEAR_OPERATION,
          operationId: "completed-clear",
          status: "completed",
          message: "Fresh context",
        }),
      },
      {
        threadId: thread.id,
        sequence: 6,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Newest response" }),
      },
    ]);

    const timeline = buildThreadTimeline(db, thread, {
      eventBudget: 1_000,
      includeNestedRows: true,
      includeProviderUnhandledOperations: false,
      maxInlineOutputChars: null,
      maxSeq: 6,
      page: { kind: "latest", segmentLimit: 20 },
    });

    expect(timeline.contextBoundarySeq).toBe(5);
    expect(
      timeline.rows.map((row) => {
        if (row.kind === "conversation") return row.text;
        if (row.kind === "system") return row.title;
        return row.kind;
      }),
    ).toEqual(["Context cleared", "Newest response"]);
    expect(timeline.contextWindowUsage).toBeUndefined();
    expect(timeline.timelinePage).toMatchObject({
      hasOlderRows: false,
      olderCursor: null,
    });
    expect(
      buildThreadConversationOutline(db, thread, { maxSeq: 6 }).items.map(
        (item) => item.preview,
      ),
    ).toEqual(["Newest response"]);
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(6);
    db.$client.close();
  });
});
