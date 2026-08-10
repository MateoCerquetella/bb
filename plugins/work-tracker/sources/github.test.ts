import { createFakePluginHost } from '@bb/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { createGithubAdapter } from './github.js';

function githubIssue() {
  return {
    repo: 'get-bb/bb',
    number: 42,
    kind: 'issue' as const,
    title: 'Refresh external work',
    state: 'OPEN',
    author: 'mateo',
    labels: [],
    assignees: ['mateo'],
    url: 'https://github.com/get-bb/bb/issues/42',
    body: 'Keep the tracker cache fresh.',
    updatedAt: '2026-08-10T12:00:00.000Z'
  };
}

describe('GitHub adapter refresh', () => {
  it('refreshes the official GitHub plugin only for explicit refreshes', async () => {
    const calls: string[] = [];
    const host = createFakePluginHost({
      pluginId: 'work-tracker-github-refresh-test',
      sdk: {
        plugins: {
          callRpc: async ({ method }) => {
            calls.push(method);
            if (method === 'refresh') return { repos: 1, items: 1 };
            if (method === 'status') {
              return {
                ghOk: true,
                ghError: null,
                repos: [{ repo: 'get-bb/bb', projectId: 'proj_bb' }],
                lastSyncedAt: '2026-08-10T12:00:00.000Z'
              };
            }
            if (method === 'listItems') return { items: [githubIssue()] };
            throw new Error(`Unexpected GitHub RPC method ${method}`);
          }
        }
      }
    });
    try {
      const adapter = createGithubAdapter(host.bb, true, 'proj_bb');

      await adapter.list();
      expect(calls).toEqual(['status', 'listItems']);

      calls.length = 0;
      await adapter.list({ refresh: true });
      expect(calls).toEqual(['refresh', 'status', 'listItems']);
    } finally {
      await host.harness.dispose();
    }
  });
});
