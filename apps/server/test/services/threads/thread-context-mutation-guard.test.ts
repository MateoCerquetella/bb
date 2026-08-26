import { describe, expect, it } from "vitest";
import {
  withThreadContextClearGuard,
  withThreadSendGuard,
} from "../../../src/services/threads/thread-context-mutation-guard.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("thread context mutation guard", () => {
  it("rejects sends while a context clear owns the thread", async () => {
    const started = deferred();
    const release = deferred();
    const clear = withThreadContextClearGuard("thread-clear", async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;

    await expect(
      withThreadSendGuard("thread-clear", async () => {}),
    ).rejects.toMatchObject({ status: 409 });
    release.resolve();
    await clear;
  });

  it("rejects a context clear while a send owns the thread", async () => {
    const started = deferred();
    const release = deferred();
    const send = withThreadSendGuard("thread-send", async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;

    await expect(
      withThreadContextClearGuard("thread-send", async () => {}),
    ).rejects.toMatchObject({ status: 409 });
    release.resolve();
    await send;
  });
});
