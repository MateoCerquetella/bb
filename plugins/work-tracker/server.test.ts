import { mkdirSync, rmdirSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { writeSecretFile } from '@bb/secret-storage';
import { createFakePluginHost } from '@bb/plugin-sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem, WorkSource } from './contract.js';
import { createProjectCredentialVault } from './credentials.js';
import plugin from './server.js';
import { createWorkItemStore } from './store.js';

const githubIssue = {
  repo: 'get-bb/bb',
  number: 314,
  kind: 'issue' as const,
  title: 'Unify external work',
  state: 'OPEN',
  author: 'mateo',
  labels: ['tracker'],
  assignees: ['mateo'],
  url: 'https://github.com/get-bb/bb/issues/314',
  body: 'Show this issue in BB.',
  updatedAt: '2026-08-10T12:00:00.000Z'
};

const githubDetail = {
  issue: {
    repo: githubIssue.repo,
    number: githubIssue.number,
    title: githubIssue.title,
    state: githubIssue.state,
    author: githubIssue.author,
    labels: githubIssue.labels,
    assignees: githubIssue.assignees,
    url: githubIssue.url,
    body: githubIssue.body,
    updatedAt: githubIssue.updatedAt,
    comments: [
      {
        author: 'reviewer',
        body: 'Ready to test.',
        createdAt: '2026-08-10T12:05:00.000Z'
      }
    ]
  }
};

function cachedItem(source: WorkSource, locator: string): WorkItem {
  return {
    bbProjectId: 'proj_bb',
    source,
    locator,
    key: locator,
    title: `${source} cached item`,
    description: 'Cached work',
    url: `https://example.com/${locator}`,
    status: 'Open',
    stateCategory: 'todo',
    priority: null,
    assignee: null,
    project: 'BB',
    labels: [],
    updatedAt: '2026-08-10T12:00:00.000Z'
  };
}

function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!settle) throw new Error('Deferred promise was not initialized');
      settle(value);
    }
  };
}

function createHost() {
  let githubState = githubIssue.state;
  return createFakePluginHost({
    pluginId: 'work-tracker',
    sdk: {
      projects: {
        async list() {
          return [
            { id: 'proj_other', name: 'Another project', deletedAt: null },
            { id: 'proj_bb', name: 'BB', deletedAt: null }
          ];
        }
      },
      plugins: {
        callRpc: async ({ method }) => {
          if (method === 'refresh') return { repos: 1, items: 1 };
          if (method === 'status') {
            return {
              ghOk: true,
              ghError: null,
              repos: [{ repo: 'get-bb/bb', projectId: 'proj_bb' }],
              lastSyncedAt: null
            };
          }
          if (method === 'listItems') {
            return { items: [{ ...githubIssue, state: githubState }] };
          }
          if (method === 'getIssue') {
            return {
              issue: { ...githubDetail.issue, state: githubState }
            };
          }
          if (method === 'setIssueState') {
            githubState = githubState === 'OPEN' ? 'CLOSED' : 'OPEN';
            return { ok: true };
          }
          throw new Error(`Unexpected GitHub RPC method ${method}`);
        }
      }
    }
  });
}

async function setup() {
  const host = createHost();
  await plugin(host.bb);
  return host;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Work Tracker plugin', () => {
  it('registers RPC, CLI, mention, and background surfaces without plugin-wide settings', async () => {
    const host = await setup();
    try {
      expect(host.harness.registrations.rpcMethods).toEqual([
        'listProjects',
        'status',
        'listItems',
        'refresh',
        'getItem',
        'statusOptions',
        'updateItemStatus',
        'getProjectConfig',
        'saveProjectConfig'
      ]);
      expect(host.harness.registrations.cli).toMatchObject({ name: 'work' });
      expect(host.harness.registrations.mentionProviders).toHaveLength(1);
      expect(
        host.harness.registrations.services.map(service => service.name)
      ).toEqual(['sync']);
      expect(
        Object.keys(host.harness.registrations.settingsDescriptors)
      ).toEqual([]);
    } finally {
      await host.harness.dispose();
    }
  });

  it('refreshes GitHub into the cache and exposes the same item through RPC, CLI, and mentions', async () => {
    const host = await setup();
    try {
      await expect(
        host.harness.callRpc('refresh', {
          projectId: 'proj_bb',
          source: 'github'
        })
      ).resolves.toMatchObject({ itemCount: 1 });
      await expect(
        host.harness.callRpc('listItems', {
          projectId: 'proj_bb',
          source: 'github',
          limit: 20
        })
      ).resolves.toMatchObject({
        items: [
          {
            bbProjectId: 'proj_bb',
            source: 'github',
            locator: 'get-bb/bb#314',
            key: 'get-bb/bb#314',
            title: 'Unify external work'
          }
        ]
      });

      await expect(
        host.harness.runCli(['list', '--cached', '--json'], {
          projectId: 'proj_bb'
        })
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('get-bb/bb#314')
      });
      await expect(
        host.harness.callRpc('getItem', {
          projectId: 'proj_bb',
          source: 'github',
          locator: 'get-bb/bb#314'
        })
      ).resolves.toMatchObject({
        item: {
          bbProjectId: 'proj_bb',
          comments: [{ author: 'reviewer', body: 'Ready to test.' }]
        }
      });

      const provider = host.harness.registrations.mentionProviders[0]!;
      expect(
        await provider.search({
          trigger: '@',
          query: '314',
          projectId: 'proj_bb',
          threadId: null
        })
      ).toMatchObject([{ title: 'get-bb/bb#314 Unify external work' }]);
      await expect(
        provider.resolve('proj_bb:github:get-bb/bb#314')
      ).resolves.toEqual({
        context: expect.stringContaining('# GitHub issue get-bb/bb#314')
      });
      expect(
        await provider.search({
          trigger: '@',
          query: '314',
          projectId: null,
          threadId: null
        })
      ).toEqual([]);
      await expect(
        host.harness.callRpc('getItem', {
          projectId: 'proj_other',
          source: 'github',
          locator: 'get-bb/bb#314'
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('is not cached for this BB project')
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('lists native transitions and moves only the owning cached issue through RPC and CLI', async () => {
    const host = await setup();
    try {
      await host.harness.callRpc('refresh', {
        projectId: 'proj_bb',
        source: 'github'
      });
      await expect(
        host.harness.callRpc('statusOptions', {
          projectId: 'proj_bb',
          source: 'github',
          locator: 'get-bb/bb#314'
        })
      ).resolves.toEqual({
        options: [
          {
            id: 'open',
            name: 'Open',
            stateCategory: 'todo',
            current: true
          },
          {
            id: 'closed',
            name: 'Closed',
            stateCategory: 'done',
            current: false
          }
        ]
      });
      await expect(
        host.harness.callRpc('updateItemStatus', {
          projectId: 'proj_bb',
          source: 'github',
          locator: 'get-bb/bb#314',
          statusId: 'closed'
        })
      ).resolves.toMatchObject({
        item: {
          bbProjectId: 'proj_bb',
          status: 'CLOSED',
          stateCategory: 'done'
        }
      });
      expect(
        host.harness.realtimeSignals.some(
          signal =>
            signal.channel === 'work-tracker:changed' &&
            JSON.stringify(signal.payload) ===
              JSON.stringify({ projectId: 'proj_bb', source: 'github' })
        )
      ).toBe(true);
      await expect(
        host.harness.callRpc('statusOptions', {
          projectId: 'proj_other',
          source: 'github',
          locator: 'get-bb/bb#314'
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('is not cached for this BB project')
      });

      await expect(
        host.harness.runCli(
          [
            'transitions',
            'github',
            'get-bb/bb#314',
            '--project',
            'proj_bb',
            '--json'
          ],
          { projectId: 'proj_other' }
        )
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('"current": true')
      });
      await expect(
        host.harness.runCli(
          [
            'move',
            'github',
            'get-bb/bb#314',
            '--status',
            'open',
            '--project',
            'proj_bb',
            '--json'
          ],
          { projectId: 'proj_other' }
        )
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('"status": "OPEN"')
      });
      await expect(
        host.harness.runCli(
          ['move', 'github', 'get-bb/bb#314', '--project', 'proj_bb'],
          { projectId: 'proj_bb' }
        )
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining('--status <id>')
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('rejects a stale refresh result after an authoritative status move', async () => {
    const host = await setup();
    const staleListStarted = deferred<void>();
    const staleList = deferred<{ items: [typeof githubIssue] }>();
    let providerState: string = githubIssue.state;
    let listCalls = 0;
    try {
      await host.harness.callRpc('refresh', {
        projectId: 'proj_bb',
        source: 'github'
      });
      host.harness.sdk.stub('plugins.callRpc', async ({ method }) => {
        if (method === 'refresh') return { repos: 1, items: 1 };
        if (method === 'status') {
          return {
            ghOk: true,
            ghError: null,
            repos: [{ repo: 'get-bb/bb', projectId: 'proj_bb' }],
            lastSyncedAt: null
          };
        }
        if (method === 'listItems') {
          listCalls += 1;
          if (listCalls === 1) {
            staleListStarted.resolve(undefined);
            return staleList.promise;
          }
          return { items: [{ ...githubIssue, state: providerState }] };
        }
        if (method === 'getIssue') {
          return {
            issue: { ...githubDetail.issue, state: providerState }
          };
        }
        if (method === 'setIssueState') {
          providerState = 'CLOSED';
          return { ok: true };
        }
        throw new Error(`Unexpected GitHub RPC method ${method}`);
      });

      const refresh = host.harness.callRpc('refresh', {
        projectId: 'proj_bb',
        source: 'github'
      });
      await staleListStarted.promise;
      await expect(
        host.harness.callRpc('updateItemStatus', {
          projectId: 'proj_bb',
          source: 'github',
          locator: 'get-bb/bb#314',
          statusId: 'closed'
        })
      ).resolves.toMatchObject({ item: { status: 'CLOSED' } });

      staleList.resolve({ items: [{ ...githubIssue, state: 'OPEN' }] });
      await refresh;
      const store = createWorkItemStore(host.bb);
      await vi.waitFor(() => {
        expect(store.get('proj_bb', 'github', 'get-bb/bb#314')?.status).toBe(
          'CLOSED'
        );
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('lists BB projects and persists source filters independently per project', async () => {
    const host = await setup();
    try {
      await expect(host.harness.callRpc('listProjects', null)).resolves.toEqual(
        {
          projects: [
            { id: 'proj_other', name: 'Another project' },
            { id: 'proj_bb', name: 'BB' }
          ]
        }
      );
      await expect(
        host.harness.callRpc('getProjectConfig', { projectId: 'proj_bb' })
      ).resolves.toMatchObject({
        config: {
          projectId: 'proj_bb',
          githubEnabled: true,
          githubRepos: ['get-bb/bb'],
          linearEnabled: false,
          linearTeamKey: '',
          jiraEnabled: false,
          jiraBaseUrl: '',
          jiraEmail: '',
          linearCredentialConfigured: false,
          jiraCredentialConfigured: false
        }
      });
      await expect(
        host.harness.callRpc('saveProjectConfig', {
          projectId: 'proj_bb',
          githubEnabled: false,
          linearEnabled: true,
          linearTeamKey: 'ENG',
          jiraEnabled: true,
          jiraBaseUrl: 'https://bb.atlassian.net',
          jiraEmail: 'mateo@example.com',
          jiraJql: 'project = BB',
          linearCredential: {
            operation: 'set',
            value: 'linear-rpc-sentinel'
          },
          jiraCredential: { operation: 'clear' }
        })
      ).resolves.toEqual({
        config: {
          projectId: 'proj_bb',
          githubEnabled: false,
          githubRepos: ['get-bb/bb'],
          linearEnabled: true,
          linearTeamKey: 'ENG',
          jiraEnabled: true,
          jiraBaseUrl: 'https://bb.atlassian.net',
          jiraEmail: 'mateo@example.com',
          jiraJql: 'project = BB',
          linearCredentialConfigured: true,
          jiraCredentialConfigured: false
        }
      });
      await expect(
        host.harness.callRpc('getProjectConfig', { projectId: 'proj_other' })
      ).resolves.toMatchObject({
        config: { projectId: 'proj_other', githubEnabled: true }
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('keeps credential values isolated by project and redacts RPC results, signals, and logs', async () => {
    const host = await setup();
    try {
      const firstValue = 'linear-alpha-sentinel';
      const secondValue = 'linear-beta-sentinel';
      const baseConfig = {
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project IS NOT EMPTY',
        jiraCredential: { operation: 'keep' as const }
      };
      const first = await host.harness.callRpc('saveProjectConfig', {
        projectId: 'proj_bb',
        ...baseConfig,
        linearCredential: { operation: 'set', value: firstValue }
      });
      const second = await host.harness.callRpc('saveProjectConfig', {
        projectId: 'proj_other',
        ...baseConfig,
        linearCredential: { operation: 'set', value: secondValue }
      });
      const vault = createProjectCredentialVault(host.bb);

      expect(await vault.read('proj_bb', 'linear')).toBe(firstValue);
      expect(await vault.read('proj_other', 'linear')).toBe(secondValue);
      const observable = JSON.stringify({
        first,
        second,
        signals: host.harness.realtimeSignals,
        logs: host.harness.logEntries
      });
      expect(observable).not.toContain(firstValue);
      expect(observable).not.toContain(secondValue);
      expect(first).toMatchObject({
        config: { linearCredentialConfigured: true }
      });
      expect(second).toMatchObject({
        config: { linearCredentialConfigured: true }
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('binds Jira token changes to the saved Atlassian origin and account', async () => {
    const host = await setup();
    try {
      const initialToken = 'jira-initial-sentinel';
      const replacementToken = 'jira-replacement-sentinel';
      const initial = {
        projectId: 'proj_bb',
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: false,
        jiraBaseUrl: 'https://first.atlassian.net',
        jiraEmail: 'mateo@example.com',
        jiraJql: 'project = BB',
        linearCredential: { operation: 'keep' as const },
        jiraCredential: { operation: 'set' as const, value: initialToken }
      };
      await host.harness.callRpc('saveProjectConfig', initial);
      const vault = createProjectCredentialVault(host.bb);
      expect(await vault.read('proj_bb', 'jira')).toBe(initialToken);
      const store = createWorkItemStore(host.bb);
      store.replaceSource(
        'proj_bb',
        'jira',
        [cachedItem('jira', 'BB-keep-cache')],
        '2026-08-10T12:00:00.000Z'
      );

      await expect(
        host.harness.callRpc('saveProjectConfig', {
          ...initial,
          jiraBaseUrl: 'https://second.atlassian.net',
          jiraCredential: { operation: 'keep' }
        })
      ).rejects.toThrow(
        'requires a replacement token or explicit token removal'
      );
      expect(await vault.read('proj_bb', 'jira')).toBe(initialToken);
      expect(store.get('proj_bb', 'jira', 'BB-keep-cache')).toBeDefined();

      const lookupStarted = deferred<void>();
      const releaseLookup = deferred<void>();
      let projectLookups = 0;
      host.harness.sdk.stub('projects.list', async () => {
        projectLookups += 1;
        if (projectLookups === 1) {
          lookupStarted.resolve(undefined);
          await releaseLookup.promise;
        }
        return [
          { id: 'proj_other', name: 'Another project', deletedAt: null },
          { id: 'proj_bb', name: 'BB', deletedAt: null }
        ];
      });
      const replacement = host.harness.callRpc('saveProjectConfig', {
        ...initial,
        jiraBaseUrl: 'https://second.atlassian.net',
        jiraCredential: { operation: 'set', value: replacementToken }
      });
      await lookupStarted.promise;
      const staleLinearSave = host.harness.callRpc('saveProjectConfig', {
        ...initial,
        linearCredential: {
          operation: 'set',
          value: 'stale-linear-sentinel'
        },
        jiraCredential: { operation: 'keep' }
      });
      releaseLookup.resolve(undefined);
      const result = await replacement;
      await expect(staleLinearSave).rejects.toThrow(
        'requires a replacement token or explicit token removal'
      );
      expect(await vault.read('proj_bb', 'jira')).toBe(replacementToken);
      expect(await vault.read('proj_bb', 'linear')).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(replacementToken);
      await expect(
        host.harness.callRpc('saveProjectConfig', {
          ...initial,
          jiraCredential: { operation: 'keep' }
        })
      ).rejects.toThrow(
        'requires a replacement token or explicit token removal'
      );
      expect(await vault.read('proj_bb', 'jira')).toBe(replacementToken);
      await expect(
        host.harness.callRpc('saveProjectConfig', {
          ...initial,
          jiraBaseUrl: 'https://jira.example.com',
          jiraCredential: { operation: 'clear' }
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      await host.harness.dispose();
    }
  });

  it('restores the old Jira token when persisting its replacement destination fails', async () => {
    const host = await setup();
    try {
      const initialToken = 'jira-before-config-failure';
      const initial = {
        projectId: 'proj_bb',
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: true,
        jiraBaseUrl: 'https://first.atlassian.net',
        jiraEmail: 'mateo@example.com',
        jiraJql: 'project = BB',
        linearCredential: { operation: 'keep' as const },
        jiraCredential: { operation: 'set' as const, value: initialToken }
      };
      await host.harness.callRpc('saveProjectConfig', initial);
      host.bb.storage.database().exec(`
        CREATE TRIGGER reject_project_config_update
        BEFORE UPDATE ON project_source_config
        BEGIN
          SELECT RAISE(ABORT, 'forced config failure');
        END;
      `);

      await expect(
        host.harness.callRpc('saveProjectConfig', {
          ...initial,
          jiraBaseUrl: 'https://second.atlassian.net',
          jiraCredential: {
            operation: 'set',
            value: 'jira-after-config-failure'
          }
        })
      ).rejects.toThrow('forced config failure');
      const vault = createProjectCredentialVault(host.bb);
      expect(await vault.read('proj_bb', 'jira')).toBe(initialToken);
      await expect(
        host.harness.callRpc('getProjectConfig', { projectId: 'proj_bb' })
      ).resolves.toMatchObject({
        config: { jiraBaseUrl: 'https://first.atlassian.net' }
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('rolls back the Jira destination before restoring its token after a replacement write failure', async () => {
    const host = await setup();
    try {
      const initialToken = 'jira-before-write-failure';
      const initial = {
        projectId: 'proj_bb',
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: true,
        jiraBaseUrl: 'https://first.atlassian.net',
        jiraEmail: 'mateo@example.com',
        jiraJql: 'project = BB',
        linearCredential: { operation: 'keep' as const },
        jiraCredential: { operation: 'set' as const, value: initialToken }
      };
      await host.harness.callRpc('saveProjectConfig', initial);
      const vault = createProjectCredentialVault(host.bb);
      const tokenPath = vault.credentialPath('proj_bb', 'jira');
      const db = host.bb.storage.database();
      let updates = 0;
      db.function('toggle_jira_token_path', () => {
        updates += 1;
        if (updates === 1) mkdirSync(tokenPath);
        if (updates === 2) rmdirSync(tokenPath);
        return updates;
      });
      db.exec(`
        CREATE TRIGGER toggle_jira_token_path_after_update
        AFTER UPDATE ON project_source_config
        BEGIN
          SELECT toggle_jira_token_path();
        END;
      `);

      await expect(
        host.harness.callRpc('saveProjectConfig', {
          ...initial,
          jiraBaseUrl: 'https://second.atlassian.net',
          jiraCredential: {
            operation: 'set',
            value: 'jira-after-write-failure'
          }
        })
      ).rejects.toThrow('previous Jira bundle was restored');
      expect(updates).toBe(2);
      expect(await vault.read('proj_bb', 'jira')).toBe(initialToken);
      await expect(
        host.harness.callRpc('getProjectConfig', { projectId: 'proj_bb' })
      ).resolves.toMatchObject({
        config: { jiraBaseUrl: 'https://first.atlassian.net' }
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('rejects malformed source boundaries without contacting a connector', async () => {
    const host = await setup();
    try {
      await expect(
        host.harness.callRpc('refresh', {
          projectId: 'proj_bb',
          source: 'not-a-source'
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        host.harness.callRpc('saveProjectConfig', {
          projectId: 'proj_bb',
          githubEnabled: true,
          linearEnabled: true,
          linearTeamKey: '',
          jiraEnabled: false,
          jiraBaseUrl: '',
          jiraEmail: '',
          jiraJql: 'project = BB',
          linearCredential: { operation: 'keep' },
          jiraCredential: { operation: 'keep' }
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        host.harness.runCli(['list', '--source', 'nope'])
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: 'Source must be linear, github, or jira\n'
      });
      await expect(
        host.harness.runCli(['list', '--cached'])
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining('Choose a BB project')
      });
      const provider = host.harness.registrations.mentionProviders[0]!;
      await expect(provider.resolve('bad:thing')).rejects.toThrow(
        'Invalid Work Tracker mention'
      );
    } finally {
      await host.harness.dispose();
    }
  });

  it('does not let a late detail response resurrect an item removed by refresh', async () => {
    const host = await setup();
    const detail = deferred<typeof githubDetail>();
    const detailStarted = deferred<void>();
    try {
      const store = createWorkItemStore(host.bb);
      store.replaceSource(
        'proj_bb',
        'github',
        [cachedItem('github', 'get-bb/bb#314')],
        '2026-08-10T12:00:00.000Z'
      );
      let githubCalls = 0;
      host.harness.sdk.stub('plugins.callRpc', async () => {
        githubCalls += 1;
        if (githubCalls === 1) {
          return {
            ghOk: true,
            ghError: null,
            repos: [{ repo: 'get-bb/bb', projectId: 'proj_bb' }],
            lastSyncedAt: null
          };
        }
        detailStarted.resolve(undefined);
        return detail.promise;
      });

      const request = host.harness.callRpc('getItem', {
        projectId: 'proj_bb',
        source: 'github',
        locator: 'get-bb/bb#314'
      });
      await detailStarted.promise;
      store.replaceSource('proj_bb', 'github', [], '2026-08-10T12:10:00.000Z');
      detail.resolve(githubDetail);

      await expect(request).resolves.toMatchObject({
        item: { locator: 'get-bb/bb#314' }
      });
      expect(store.get('proj_bb', 'github', 'get-bb/bb#314')).toBeUndefined();
      expect(store.syncState('proj_bb', 'github').itemCount).toBe(0);
    } finally {
      await host.harness.dispose();
    }
  });

  it('invalidates only affected configured credential caches before project lookup', async () => {
    const host = await setup();
    const liveProjects =
      deferred<Array<{ id: string; name: string; deletedAt: null }>>();
    try {
      const store = createWorkItemStore(host.bb);
      store.saveProjectConfig({
        projectId: 'proj_bb',
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project = BB'
      });
      store.replaceSource(
        'proj_bb',
        'linear',
        [cachedItem('linear', 'lin_1')],
        '2026-08-10T12:00:00.000Z'
      );
      store.replaceSource(
        'proj_bb',
        'jira',
        [cachedItem('jira', 'BB-1')],
        '2026-08-10T12:00:00.000Z'
      );
      host.harness.sdk.stub('projects.list', () => liveProjects.promise);

      const save = host.harness.callRpc('saveProjectConfig', {
        projectId: 'proj_bb',
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project = BB',
        linearCredential: { operation: 'set', value: 'linear-new' },
        jiraCredential: { operation: 'keep' }
      });
      await vi.waitFor(() => {
        expect(store.get('proj_bb', 'linear', 'lin_1')).toBeUndefined();
      });
      expect(store.get('proj_bb', 'jira', 'BB-1')).toBeDefined();
      liveProjects.resolve([
        { id: 'proj_other', name: 'Another project', deletedAt: null },
        { id: 'proj_bb', name: 'BB', deletedAt: null }
      ]);
      await expect(save).resolves.toMatchObject({
        config: { linearCredentialConfigured: true }
      });
      expect(store.get('proj_bb', 'jira', 'BB-1')).toBeDefined();
    } finally {
      await host.harness.dispose();
    }
  });

  it('rejects an old-adapter refresh started while a config save waits for migration', async () => {
    const host = createHost();
    const migrationLookupStarted = deferred<void>();
    const releaseMigrationLookup = deferred<void>();
    const oldRefreshStarted = deferred<RequestInit>();
    const oldRefreshResponse = deferred<Response>();
    try {
      const store = createWorkItemStore(host.bb);
      store.saveProjectConfig({
        projectId: 'proj_bb',
        githubEnabled: false,
        linearEnabled: true,
        linearTeamKey: 'OLD',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project IS NOT EMPTY'
      });
      store.replaceSource(
        'proj_bb',
        'linear',
        [cachedItem('linear', 'old-cached-item')],
        '2026-08-10T12:00:00.000Z'
      );
      const vault = createProjectCredentialVault(host.bb);
      await vault.mutate('proj_bb', 'linear', {
        operation: 'set',
        value: 'old-linear-credential'
      });
      await plugin(host.bb);

      let projectLookups = 0;
      host.harness.sdk.stub('projects.list', async () => {
        projectLookups += 1;
        if (projectLookups === 1) {
          migrationLookupStarted.resolve(undefined);
          await releaseMigrationLookup.promise;
        }
        return [
          { id: 'proj_other', name: 'Another project', deletedAt: null },
          { id: 'proj_bb', name: 'BB', deletedAt: null }
        ];
      });
      let fetchCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            oldRefreshStarted.resolve(init ?? {});
            return oldRefreshResponse.promise;
          }
          return new Response(
            JSON.stringify({
              data: {
                issues: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        })
      );

      const service = host.harness.runService('sync');
      await migrationLookupStarted.promise;
      const save = host.harness.callRpc('saveProjectConfig', {
        projectId: 'proj_bb',
        githubEnabled: false,
        linearEnabled: true,
        linearTeamKey: 'NEW',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project IS NOT EMPTY',
        linearCredential: { operation: 'keep' },
        jiraCredential: { operation: 'keep' }
      });
      const refresh = host.harness.callRpc('refresh', {
        projectId: 'proj_bb',
        source: 'linear'
      });
      const oldRequest = await oldRefreshStarted.promise;
      expect(JSON.parse(String(oldRequest.body))).toMatchObject({
        variables: { teamKey: 'OLD' }
      });

      releaseMigrationLookup.resolve(undefined);
      await expect(save).resolves.toMatchObject({
        config: { linearTeamKey: 'NEW' }
      });
      oldRefreshResponse.resolve(
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: 'old-response-item',
                    identifier: 'OLD-1',
                    title: 'Old identity response',
                    description: '',
                    url: 'https://linear.app/example/issue/OLD-1',
                    priorityLabel: '',
                    updatedAt: '2026-08-10T12:01:00.000Z',
                    state: { name: 'Todo', type: 'unstarted' },
                    assignee: null,
                    team: { key: 'OLD', name: 'Old team' },
                    project: null,
                    labels: { nodes: [] }
                  }
                ],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
      await refresh;
      expect(
        store.get('proj_bb', 'linear', 'old-response-item')
      ).toBeUndefined();
      service.controller.abort();
      await service.done;
    } finally {
      await host.harness.dispose();
    }
  });

  it('parses refresh flags around the source and reports connector failures', async () => {
    const host = await setup();
    try {
      await expect(
        host.harness.runCli([
          'refresh',
          '--project',
          'proj_bb',
          '--json',
          'github'
        ])
      ).resolves.toMatchObject({ exitCode: 0 });
      await expect(
        host.harness.runCli(['refresh', '--project', 'proj_bb'])
      ).resolves.toMatchObject({ exitCode: 0 });
      await expect(
        host.harness.runCli(['refresh', 'github', '--project'], {
          projectId: 'proj_bb'
        })
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: '--project requires a value\n'
      });
      await expect(
        host.harness.runCli([
          'refresh',
          'github',
          'extra',
          '--project',
          'proj_bb'
        ])
      ).resolves.toMatchObject({ exitCode: 1 });

      host.harness.sdk.stub('plugins.callRpc', async () => {
        throw new Error('GitHub refresh unavailable');
      });
      await expect(
        host.harness.runCli(['refresh', 'github', '--project', 'proj_bb'])
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: 'GitHub refresh failed: GitHub refresh unavailable\n'
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('shows and updates project connector config through the CLI', async () => {
    const host = await setup();
    try {
      const result = await host.harness.runCli([
        'config',
        '--project',
        'proj_bb',
        '--github',
        'off',
        '--linear',
        'on',
        '--linear-team',
        'ENG',
        '--jira-jql',
        'project = BB',
        '--json'
      ]);
      expect(result).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(result.stdout ?? '')).toMatchObject({
        config: {
          projectId: 'proj_bb',
          githubEnabled: false,
          githubRepos: ['get-bb/bb'],
          linearEnabled: true,
          linearTeamKey: 'ENG',
          jiraJql: 'project = BB'
        }
      });
      await expect(
        host.harness.runCli(['config', '--github', 'maybe'], {
          projectId: 'proj_bb'
        })
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: '--github must be on or off\n'
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('never loses unspecified fields across concurrent partial CLI config updates', async () => {
    const host = await setup();
    try {
      const [linearResult, githubResult] = await Promise.all([
        host.harness.runCli(
          [
            'config',
            '--project',
            'proj_bb',
            '--linear',
            'on',
            '--linear-team',
            'ENG'
          ],
          { projectId: 'proj_bb' }
        ),
        host.harness.runCli(
          ['config', '--project', 'proj_bb', '--github', 'off'],
          { projectId: 'proj_bb' }
        )
      ]);
      const results = [linearResult, githubResult];
      expect(results.some(result => result.exitCode === 0)).toBe(true);
      const config = createWorkItemStore(host.bb).projectConfig('proj_bb', {
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project IS NOT EMPTY'
      });
      if (results.every(result => result.exitCode === 0)) {
        expect(config).toMatchObject({
          linearEnabled: true,
          linearTeamKey: 'ENG',
          githubEnabled: false
        });
      } else {
        expect(
          results
            .filter(result => result.exitCode === 1)
            .every(result => result.stderr.includes('state changed'))
        ).toBe(true);
        expect(
          (config.linearEnabled && config.githubEnabled) ||
            (!config.linearEnabled && !config.githubEnabled)
        ).toBe(true);
      }
    } finally {
      await host.harness.dispose();
    }
  });

  it('collects credentials through an authenticated project-bound interaction and emits status only', async () => {
    const host = await setup();
    try {
      const cli = host.harness.runCli(
        ['credentials', '--project', 'proj_bb', '--json'],
        { projectId: 'proj_bb', threadId: 'thr_test' }
      );
      await vi.waitFor(() => {
        expect(host.harness.pendingInteractions).toHaveLength(1);
      });
      const interaction = host.harness.pendingInteractions[0]!;
      expect(interaction).toMatchObject({
        rendererId: 'work-tracker-credentials',
        payload: {
          projectId: 'proj_bb',
          projectName: 'BB',
          linearTeamKey: '',
          jiraBaseUrl: '',
          jiraEmail: '',
          linearCredentialConfigured: false,
          jiraCredentialConfigured: false
        }
      });
      const value = 'interactive-linear-sentinel';
      expect(JSON.stringify(interaction.payload)).not.toContain(value);
      host.harness.submitInteraction(interaction.id, {
        linearCredential: { operation: 'set', value },
        jiraCredential: { operation: 'keep' }
      });

      const result = await cli;
      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout).not.toContain(value);
      expect(JSON.parse(result.stdout)).toEqual({
        projectId: 'proj_bb',
        linearCredentialConfigured: true,
        jiraCredentialConfigured: false
      });

      const racedCli = host.harness.runCli(
        ['credentials', '--project', 'proj_bb'],
        { projectId: 'proj_bb', threadId: 'thr_test' }
      );
      await vi.waitFor(() => {
        expect(host.harness.pendingInteractions).toHaveLength(1);
      });
      const racedInteraction = host.harness.pendingInteractions[0]!;
      expect(racedInteraction.payload).toMatchObject({
        linearTeamKey: '',
        jiraBaseUrl: '',
        jiraEmail: ''
      });
      await host.harness.callRpc('saveProjectConfig', {
        projectId: 'proj_bb',
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: 'ENG',
        jiraEnabled: false,
        jiraBaseUrl: 'https://changed.atlassian.net',
        jiraEmail: 'changed@example.com',
        jiraJql: 'project = BB',
        linearCredential: { operation: 'keep' },
        jiraCredential: { operation: 'keep' }
      });
      const racedValue = 'raced-jira-sentinel';
      host.harness.submitInteraction(racedInteraction.id, {
        linearCredential: { operation: 'keep' },
        jiraCredential: { operation: 'set', value: racedValue }
      });
      await expect(racedCli).resolves.toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining('state changed')
      });
      const vault = createProjectCredentialVault(host.bb);
      expect(await vault.read('proj_bb', 'jira')).toBeUndefined();
      expect((await racedCli).stderr).not.toContain(racedValue);
      await expect(
        host.harness.callRpc('getProjectConfig', { projectId: 'proj_bb' })
      ).resolves.toMatchObject({
        config: {
          linearTeamKey: 'ENG',
          jiraBaseUrl: 'https://changed.atlassian.net',
          jiraEmail: 'changed@example.com'
        }
      });

      const staleRotationCli = host.harness.runCli(
        ['credentials', '--project', 'proj_bb'],
        { projectId: 'proj_bb', threadId: 'thr_test' }
      );
      await vi.waitFor(() => {
        expect(host.harness.pendingInteractions).toHaveLength(1);
      });
      const staleRotationInteraction = host.harness.pendingInteractions[0]!;
      const newerLinearValue = 'newer-linear-rotation';
      await host.harness.callRpc('saveProjectConfig', {
        projectId: 'proj_bb',
        githubEnabled: true,
        linearEnabled: false,
        linearTeamKey: 'ENG',
        jiraEnabled: false,
        jiraBaseUrl: 'https://changed.atlassian.net',
        jiraEmail: 'changed@example.com',
        jiraJql: 'project = BB',
        linearCredential: { operation: 'set', value: newerLinearValue },
        jiraCredential: { operation: 'keep' }
      });
      const store = createWorkItemStore(host.bb);
      store.replaceSource(
        'proj_bb',
        'linear',
        [cachedItem('linear', 'fresh-cache-item')],
        '2026-08-10T12:30:00.000Z'
      );
      const staleLinearValue = 'stale-linear-rotation';
      host.harness.submitInteraction(staleRotationInteraction.id, {
        linearCredential: { operation: 'set', value: staleLinearValue },
        jiraCredential: { operation: 'keep' }
      });
      const staleRotationResult = await staleRotationCli;
      expect(staleRotationResult).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining('state changed')
      });
      expect(staleRotationResult.stderr).not.toContain(staleLinearValue);
      expect(await vault.read('proj_bb', 'linear')).toBe(newerLinearValue);
      expect(store.get('proj_bb', 'linear', 'fresh-cache-item')).toBeDefined();
      await expect(
        host.harness.runCli(
          ['credentials', '--api-key=credential-argv-sentinel'],
          {
            projectId: 'proj_bb',
            threadId: 'thr_test'
          }
        )
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: 'Unsupported bb work option\n'
      });
      for (const argv of [
        ['credential-command-sentinel'],
        [
          'list',
          '--source',
          'credential-source-sentinel',
          '--project',
          'proj_bb'
        ]
      ]) {
        const rejected = await host.harness.runCli(argv, {
          projectId: 'proj_bb',
          threadId: 'thr_test'
        });
        expect(rejected).toMatchObject({ exitCode: 1 });
        expect(rejected.stderr).not.toContain('credential-');
      }
      const locatorRejected = await host.harness.runCli(
        [
          'show',
          'linear',
          'credential-locator-sentinel',
          '--project',
          'proj_bb'
        ],
        { projectId: 'proj_bb', threadId: 'thr_test' }
      );
      expect(locatorRejected).toMatchObject({ exitCode: 1 });
      expect(locatorRejected.stderr).not.toContain(
        'credential-locator-sentinel'
      );
      const projectRejected = await host.harness.runCli([
        'status',
        '--project',
        'proj_credential-project-sentinel'
      ]);
      expect(projectRejected).toMatchObject({ exitCode: 1 });
      expect(projectRejected.stderr).not.toContain(
        'proj_credential-project-sentinel'
      );
      await expect(
        host.harness.runCli(['credentials'], { projectId: 'proj_bb' })
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining('active BB thread')
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it('migrates a sole legacy credential only from the activated service', async () => {
    const host = createHost();
    try {
      const store = createWorkItemStore(host.bb);
      store.saveProjectConfig({
        projectId: 'proj_bb',
        githubEnabled: true,
        linearEnabled: true,
        linearTeamKey: 'ENG',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project = BB'
      });
      const vault = createProjectCredentialVault(host.bb);
      const legacyPath = vault.legacyCredentialPath('linear');
      await writeSecretFile(legacyPath, 'legacy-linear-sentinel');
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: {
                  issues: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null }
                  }
                }
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
        )
      );

      await plugin(host.bb);
      expect(await vault.configured('proj_bb', 'linear')).toBe(false);
      await expect(readFile(legacyPath, 'utf8')).resolves.toBe(
        'legacy-linear-sentinel'
      );

      const service = host.harness.runService('sync');
      await vi.waitFor(async () => {
        expect(await vault.configured('proj_bb', 'linear')).toBe(true);
      });
      await expect(access(legacyPath)).rejects.toMatchObject({
        code: 'ENOENT'
      });
      service.controller.abort();
      await service.done;
    } finally {
      await host.harness.dispose();
    }
  });

  it('preserves ambiguous legacy credentials while clearing mixed project caches', async () => {
    const host = createHost();
    try {
      const store = createWorkItemStore(host.bb);
      for (const projectId of ['proj_bb', 'proj_other']) {
        store.saveProjectConfig({
          projectId,
          githubEnabled: false,
          linearEnabled: true,
          linearTeamKey: projectId === 'proj_bb' ? 'ENG' : 'OPS',
          jiraEnabled: false,
          jiraBaseUrl: '',
          jiraEmail: '',
          jiraJql: 'project IS NOT EMPTY'
        });
        store.replaceSource(
          projectId,
          'linear',
          [
            {
              ...cachedItem('linear', `${projectId}-item`),
              bbProjectId: projectId
            }
          ],
          '2026-08-10T12:00:00.000Z'
        );
      }
      const vault = createProjectCredentialVault(host.bb);
      const legacyPath = vault.legacyCredentialPath('linear');
      await writeSecretFile(legacyPath, 'ambiguous-linear-sentinel');
      await plugin(host.bb);

      const service = host.harness.runService('sync');
      await vi.waitFor(() => {
        expect(store.list({ projectId: 'proj_bb', limit: 20 })).toEqual([]);
        expect(store.list({ projectId: 'proj_other', limit: 20 })).toEqual([]);
      });
      expect(await vault.configured('proj_bb', 'linear')).toBe(false);
      expect(await vault.configured('proj_other', 'linear')).toBe(false);
      await expect(readFile(legacyPath, 'utf8')).resolves.toBe(
        'ambiguous-linear-sentinel'
      );
      service.controller.abort();
      await service.done;
    } finally {
      await host.harness.dispose();
    }
  });

  it('does not copy a legacy credential when another enabled project already has a scoped identity', async () => {
    const host = createHost();
    try {
      const store = createWorkItemStore(host.bb);
      for (const projectId of ['proj_bb', 'proj_other']) {
        store.saveProjectConfig({
          projectId,
          githubEnabled: false,
          linearEnabled: true,
          linearTeamKey: projectId === 'proj_bb' ? 'ENG' : 'OPS',
          jiraEnabled: false,
          jiraBaseUrl: '',
          jiraEmail: '',
          jiraJql: 'project IS NOT EMPTY'
        });
      }
      store.replaceSource(
        'proj_other',
        'linear',
        [
          {
            ...cachedItem('linear', 'other-mixed-item'),
            bbProjectId: 'proj_other'
          }
        ],
        '2026-08-10T12:00:00.000Z'
      );
      const vault = createProjectCredentialVault(host.bb);
      await vault.mutate('proj_bb', 'linear', {
        operation: 'set',
        value: 'existing-scoped-value'
      });
      const legacyPath = vault.legacyCredentialPath('linear');
      await writeSecretFile(legacyPath, 'legacy-unassigned-value');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 503 }))
      );
      await plugin(host.bb);

      const service = host.harness.runService('sync');
      await vi.waitFor(() => {
        expect(store.list({ projectId: 'proj_other', limit: 20 })).toEqual([]);
      });
      expect(await vault.read('proj_bb', 'linear')).toBe(
        'existing-scoped-value'
      );
      expect(await vault.configured('proj_other', 'linear')).toBe(false);
      await expect(readFile(legacyPath, 'utf8')).resolves.toBe(
        'legacy-unassigned-value'
      );
      service.controller.abort();
      await service.done;
    } finally {
      await host.harness.dispose();
    }
  });

  it('rechecks migration ownership after an already-active project config save', async () => {
    const host = createHost();
    try {
      const store = createWorkItemStore(host.bb);
      store.saveProjectConfig({
        projectId: 'proj_bb',
        githubEnabled: false,
        linearEnabled: true,
        linearTeamKey: 'ENG',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project IS NOT EMPTY'
      });
      store.saveProjectConfig({
        projectId: 'proj_other',
        githubEnabled: false,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project IS NOT EMPTY'
      });
      const vault = createProjectCredentialVault(host.bb);
      const legacyPath = vault.legacyCredentialPath('linear');
      await writeSecretFile(legacyPath, 'raced-legacy-value');
      await plugin(host.bb);

      const projectLookupStarted = deferred<void>();
      const releaseProjectLookup = deferred<void>();
      let projectLookups = 0;
      host.harness.sdk.stub('projects.list', async () => {
        projectLookups += 1;
        if (projectLookups === 1) {
          projectLookupStarted.resolve(undefined);
          await releaseProjectLookup.promise;
        }
        return [
          { id: 'proj_other', name: 'Another project', deletedAt: null },
          { id: 'proj_bb', name: 'BB', deletedAt: null }
        ];
      });

      const enableSecondProject = host.harness.callRpc('saveProjectConfig', {
        projectId: 'proj_other',
        githubEnabled: false,
        linearEnabled: true,
        linearTeamKey: 'OPS',
        jiraEnabled: false,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project IS NOT EMPTY',
        linearCredential: { operation: 'keep' },
        jiraCredential: { operation: 'keep' }
      });
      await projectLookupStarted.promise;
      const service = host.harness.runService('sync');
      releaseProjectLookup.resolve(undefined);
      await enableSecondProject;

      await vi.waitFor(async () => {
        await expect(readFile(legacyPath, 'utf8')).resolves.toBe(
          'raced-legacy-value'
        );
        expect(await vault.configured('proj_bb', 'linear')).toBe(false);
        expect(await vault.configured('proj_other', 'linear')).toBe(false);
        expect(
          host.harness.logEntries.some(entry =>
            entry.message.includes('needs manual project assignment')
          )
        ).toBe(true);
      });
      service.controller.abort();
      await service.done;
    } finally {
      await host.harness.dispose();
    }
  });

  it('preserves a legacy Jira token until a sole enabled project has a destination bundle', async () => {
    const host = createHost();
    try {
      const store = createWorkItemStore(host.bb);
      store.saveProjectConfig({
        projectId: 'proj_bb',
        githubEnabled: false,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: true,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project = BB'
      });
      store.replaceSource(
        'proj_bb',
        'jira',
        [cachedItem('jira', 'BB-1')],
        '2026-08-10T12:00:00.000Z'
      );
      const vault = createProjectCredentialVault(host.bb);
      const legacyPath = vault.legacyCredentialPath('jira');
      await writeSecretFile(legacyPath, 'legacy-jira-unbound-value');
      await plugin(host.bb);

      const service = host.harness.runService('sync');
      await vi.waitFor(() => {
        expect(store.list({ projectId: 'proj_bb', limit: 20 })).toEqual([]);
        expect(
          host.harness.logEntries.some(entry =>
            entry.message.includes('needs a Jira URL and email')
          )
        ).toBe(true);
      });
      expect(await vault.configured('proj_bb', 'jira')).toBe(false);
      await expect(readFile(legacyPath, 'utf8')).resolves.toBe(
        'legacy-jira-unbound-value'
      );
      service.controller.abort();
      await service.done;
    } finally {
      await host.harness.dispose();
    }
  });

  it('clears ambiguous Jira caches for every project missing part of its destination bundle', async () => {
    const host = createHost();
    try {
      const store = createWorkItemStore(host.bb);
      store.saveProjectConfig({
        projectId: 'proj_bb',
        githubEnabled: false,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: true,
        jiraBaseUrl: 'https://bb.atlassian.net',
        jiraEmail: 'bb@example.com',
        jiraJql: 'project = BB'
      });
      store.saveProjectConfig({
        projectId: 'proj_other',
        githubEnabled: false,
        linearEnabled: false,
        linearTeamKey: '',
        jiraEnabled: true,
        jiraBaseUrl: '',
        jiraEmail: '',
        jiraJql: 'project = OTHER'
      });
      for (const projectId of ['proj_bb', 'proj_other']) {
        store.replaceSource(
          projectId,
          'jira',
          [
            {
              ...cachedItem('jira', `${projectId}-jira-item`),
              bbProjectId: projectId
            }
          ],
          '2026-08-10T12:00:00.000Z'
        );
      }
      const vault = createProjectCredentialVault(host.bb);
      await vault.mutate('proj_other', 'jira', {
        operation: 'set',
        value: 'scoped-but-unbound-jira-value'
      });
      const legacyPath = vault.legacyCredentialPath('jira');
      await writeSecretFile(legacyPath, 'ambiguous-jira-value');
      await plugin(host.bb);

      const service = host.harness.runService('sync');
      await vi.waitFor(() => {
        expect(store.list({ projectId: 'proj_bb', limit: 20 })).toEqual([]);
        expect(store.list({ projectId: 'proj_other', limit: 20 })).toEqual([]);
        expect(
          host.harness.logEntries.some(entry =>
            entry.message.includes('needs manual project assignment')
          )
        ).toBe(true);
      });
      expect(await vault.configured('proj_bb', 'jira')).toBe(false);
      expect(await vault.configured('proj_other', 'jira')).toBe(true);
      await expect(readFile(legacyPath, 'utf8')).resolves.toBe(
        'ambiguous-jira-value'
      );
      service.controller.abort();
      await service.done;
    } finally {
      await host.harness.dispose();
    }
  });
});
