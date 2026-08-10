import { createFakePluginHost } from '@bb/plugin-sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkItem } from './contract.js';
import { createWorkItemStore } from './store.js';

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    bbProjectId: 'proj_alpha',
    source: 'linear',
    locator: 'linear-1',
    key: 'ENG-1',
    title: 'Ship unified tracker',
    description: 'Connect Linear, GitHub, and Jira.',
    url: 'https://linear.app/example/issue/ENG-1',
    status: 'In Progress',
    stateCategory: 'in_progress',
    priority: 'High',
    assignee: 'Mateo',
    project: 'BB',
    labels: ['integration'],
    updatedAt: '2026-08-10T12:00:00.000Z',
    ...overrides
  };
}

function setup() {
  const host = createFakePluginHost({ pluginId: 'work-tracker-store-test' });
  hosts.push(host);
  return { host, store: createWorkItemStore(host.bb) };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.harness.dispose()));
});

describe('work item cache', () => {
  it('replaces one source atomically without disturbing other sources', () => {
    const { store } = setup();
    const github = item({
      source: 'github',
      locator: 'get-bb/bb#10',
      key: 'get-bb/bb#10',
      project: 'get-bb/bb'
    });
    store.replaceSource(
      'proj_alpha',
      'linear',
      [item(), item({ locator: 'linear-2', key: 'ENG-2' })],
      '2026-08-10T12:01:00.000Z'
    );
    store.replaceSource(
      'proj_alpha',
      'github',
      [github],
      '2026-08-10T12:02:00.000Z'
    );

    store.replaceSource(
      'proj_alpha',
      'linear',
      [item({ locator: 'linear-3', key: 'ENG-3' })],
      '2026-08-10T12:03:00.000Z'
    );

    expect(store.get('proj_alpha', 'linear', 'linear-1')).toBeUndefined();
    expect(
      store.list({
        projectId: 'proj_alpha',
        source: 'linear',
        limit: 20
      })
    ).toHaveLength(1);
    expect(store.get('proj_alpha', 'github', github.locator)).toMatchObject({
      key: github.key
    });
    expect(store.syncState('proj_alpha', 'linear')).toEqual({
      lastSyncedAt: '2026-08-10T12:03:00.000Z',
      error: null,
      itemCount: 1
    });
  });

  it('keeps stale cached items when a source refresh fails', () => {
    const { store } = setup();
    store.replaceSource(
      'proj_alpha',
      'linear',
      [item()],
      '2026-08-10T12:01:00.000Z'
    );

    store.setSourceError('proj_alpha', 'linear', 'Linear returned HTTP 503');

    expect(store.get('proj_alpha', 'linear', 'linear-1')).toMatchObject({
      key: 'ENG-1'
    });
    expect(store.syncState('proj_alpha', 'linear')).toEqual({
      lastSyncedAt: '2026-08-10T12:01:00.000Z',
      error: 'Linear returned HTTP 503',
      itemCount: 1
    });
  });

  it('upserts only the addressed project and source item', () => {
    const { store } = setup();
    const alpha = item({ bbProjectId: 'proj_alpha' });
    const beta = item({ bbProjectId: 'proj_beta' });
    store.upsert(alpha);
    store.upsert(beta);

    store.upsert({
      ...alpha,
      status: 'Shipped',
      stateCategory: 'done'
    });

    expect(store.get('proj_alpha', 'linear', alpha.locator)).toMatchObject({
      status: 'Shipped',
      stateCategory: 'done'
    });
    expect(store.get('proj_beta', 'linear', beta.locator)).toMatchObject({
      status: 'In Progress',
      stateCategory: 'in_progress'
    });
  });

  it('filters in SQLite and treats wildcard characters as literal search text', () => {
    const { store } = setup();
    store.replaceSource(
      'proj_alpha',
      'linear',
      [
        item({
          title: 'Reach 100% coverage',
          stateCategory: 'done',
          status: 'Done'
        }),
        item({
          locator: 'linear-2',
          key: 'ENG-2',
          title: 'Ordinary follow-up'
        })
      ],
      '2026-08-10T12:01:00.000Z'
    );

    expect(
      store
        .list({ projectId: 'proj_alpha', query: '100%', limit: 20 })
        .map(entry => entry.key)
    ).toEqual(['ENG-1']);
    expect(
      store
        .list({ stateCategories: ['done'], limit: 20 })
        .map(entry => entry.key)
    ).toEqual(['ENG-1']);
  });

  it('isolates identical external issues and source configuration by BB project', () => {
    const { store } = setup();
    const alpha = item({ bbProjectId: 'proj_alpha' });
    const beta = item({ bbProjectId: 'proj_beta', title: 'Beta copy' });
    store.replaceSource(
      'proj_alpha',
      'linear',
      [alpha],
      '2026-08-10T12:01:00.000Z'
    );
    store.replaceSource(
      'proj_beta',
      'linear',
      [beta],
      '2026-08-10T12:02:00.000Z'
    );

    expect(store.list({ projectId: 'proj_alpha', limit: 20 })).toMatchObject([
      { bbProjectId: 'proj_alpha', title: 'Ship unified tracker' }
    ]);
    expect(store.list({ projectId: 'proj_beta', limit: 20 })).toMatchObject([
      { bbProjectId: 'proj_beta', title: 'Beta copy' }
    ]);
    expect(store.list({ limit: 20 })).toHaveLength(2);
    expect(store.list({ projectIds: ['proj_alpha'], limit: 20 })).toMatchObject(
      [{ bbProjectId: 'proj_alpha' }]
    );
    expect(store.list({ projectIds: [], limit: 20 })).toEqual([]);

    const defaults = {
      githubEnabled: true,
      linearEnabled: false,
      linearTeamKey: '',
      jiraEnabled: false,
      jiraBaseUrl: '',
      jiraEmail: '',
      jiraJql: 'assignee = currentUser()'
    };
    expect(store.ensureProjectConfig('proj_alpha', defaults)).toEqual({
      projectId: 'proj_alpha',
      ...defaults
    });
    expect(
      store.saveProjectConfig({
        projectId: 'proj_alpha',
        githubEnabled: false,
        linearEnabled: true,
        linearTeamKey: 'ENG',
        jiraEnabled: true,
        jiraBaseUrl: 'https://bb.atlassian.net',
        jiraEmail: 'mateo@example.com',
        jiraJql: 'project = ENG'
      })
    ).toMatchObject({
      githubEnabled: false,
      linearEnabled: true,
      linearTeamKey: 'ENG',
      jiraEnabled: true,
      jiraBaseUrl: 'https://bb.atlassian.net',
      jiraEmail: 'mateo@example.com'
    });
    expect(store.configuredProjectIds()).toEqual(['proj_alpha']);
    expect(store.enabledProjectIds('linear')).toEqual(['proj_alpha']);
    expect(store.enabledProjectIds('jira')).toEqual(['proj_alpha']);
  });
});
