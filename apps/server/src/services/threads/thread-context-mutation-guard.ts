import { ApiError } from "../../errors.js";

interface ThreadContextMutationState {
  clearing: boolean;
  sends: number;
}

const stateByThreadId = new Map<string, ThreadContextMutationState>();

function stateFor(threadId: string): ThreadContextMutationState {
  const existing = stateByThreadId.get(threadId);
  if (existing) return existing;
  const created = { clearing: false, sends: 0 };
  stateByThreadId.set(threadId, created);
  return created;
}

function cleanup(threadId: string, state: ThreadContextMutationState): void {
  if (!state.clearing && state.sends === 0) stateByThreadId.delete(threadId);
}

export async function withThreadSendGuard<T>(
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  const state = stateFor(threadId);
  if (state.clearing) {
    throw new ApiError(
      409,
      "invalid_request",
      "Thread context is being cleared",
    );
  }
  state.sends += 1;
  try {
    return await work();
  } finally {
    state.sends -= 1;
    cleanup(threadId, state);
  }
}

export async function withThreadContextClearGuard<T>(
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  const state = stateFor(threadId);
  if (state.clearing || state.sends > 0) {
    cleanup(threadId, state);
    throw new ApiError(
      409,
      "invalid_request",
      "Thread is processing another request",
    );
  }
  state.clearing = true;
  try {
    return await work();
  } finally {
    state.clearing = false;
    cleanup(threadId, state);
  }
}
