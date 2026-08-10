import { createFakePluginHost } from '@bb/plugin-sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubAdapter } from './github.js';
import { createJiraAdapter } from './jira.js';
import { createLinearAdapter } from './linear.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function linearIssue() {
  return {
    id: 'issue-id',
    identifier: 'ENG-42',
    title: 'Connect external work',
    description: 'One tracker for every source.',
    url: 'https://linear.app/example/issue/ENG-42',
    priorityLabel: 'High',
    updatedAt: '2026-08-10T12:00:00.000Z',
    state: { id: 'state-started', name: 'In Progress', type: 'started' },
    assignee: { id: 'viewer-id', name: 'Mateo' },
    team: { key: 'ENG', name: 'Engineering' },
    project: null,
    labels: { nodes: [{ name: 'integration' }] }
  };
}

describe('Linear adapter', () => {
  it('normalizes team issues and authenticates without changing the token', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          data: {
            issues: {
              nodes: [linearIssue()],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLinearAdapter({
      enabled: true,
      apiKey: 'lin_test',
      teamKey: 'ENG'
    });

    await expect(adapter.list()).resolves.toEqual([
      expect.objectContaining({
        source: 'linear',
        locator: 'issue-id',
        key: 'ENG-42',
        stateCategory: 'in_progress',
        project: 'Engineering',
        labels: ['integration']
      })
    ]);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ authorization: 'lin_test' });
  });

  it('loads every team-issue page with the returned cursor', async () => {
    let page = 0;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        page += 1;
        return jsonResponse({
          data: {
            issues:
              page === 1
                ? {
                    nodes: [linearIssue()],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: 'cursor-1'
                    }
                  }
                : {
                    nodes: [
                      {
                        ...linearIssue(),
                        id: 'issue-id-2',
                        identifier: 'ENG-43'
                      }
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null }
                  }
          }
        });
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLinearAdapter({
      enabled: true,
      apiKey: 'lin_test',
      teamKey: 'ENG'
    });

    const items = await adapter.list();

    expect(items.map(item => item.key)).toEqual(['ENG-42', 'ENG-43']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject(
      { variables: { teamKey: 'ENG' } }
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject(
      { variables: { teamKey: 'ENG', after: 'cursor-1' } }
    );
  });

  it('fails closed when Linear returns a malformed boundary response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: { issues: { nodes: [{}] } } }))
    );
    const adapter = createLinearAdapter({
      enabled: true,
      apiKey: 'lin_test',
      teamKey: 'ENG'
    });

    await expect(adapter.list()).rejects.toThrow();
  });

  it('rejects a detail outside the configured team', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: {
            issue: {
              ...linearIssue(),
              team: { key: 'OPS', name: 'Operations' }
            }
          }
        })
      )
    );
    const adapter = createLinearAdapter({
      enabled: true,
      apiKey: 'lin_test',
      teamKey: 'ENG'
    });

    await expect(adapter.get('issue-id')).rejects.toThrow(
      'outside the configured scope'
    );
  });

  it('rejects a list response containing an issue outside the configured team', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  ...linearIssue(),
                  team: { key: 'OPS', name: 'Operations' }
                }
              ],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        })
      )
    );
    const adapter = createLinearAdapter({
      enabled: true,
      apiKey: 'lin_test',
      teamKey: 'ENG'
    });

    await expect(adapter.list()).rejects.toThrow('outside the configured team');
  });

  it('fails closed when no team key is selected', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLinearAdapter({
      enabled: true,
      apiKey: 'lin_test',
      teamKey: ''
    });

    expect(adapter.configured()).toBe(false);
    expect(adapter.configurationMessage()).toContain('team key');
    await expect(adapter.list()).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists the configured team workflow and updates only to a listed state', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (body.query.includes('WorkTrackerLinearStatusOptions')) {
          return jsonResponse({
            data: {
              issue: {
                id: 'issue-id',
                state: {
                  id: 'state-started',
                  name: 'In Progress',
                  type: 'started'
                },
                team: {
                  key: 'ENG',
                  states: {
                    nodes: [
                      {
                        id: 'state-started',
                        name: 'In Progress',
                        type: 'started'
                      },
                      {
                        id: 'state-done',
                        name: 'Shipped',
                        type: 'completed'
                      }
                    ]
                  }
                }
              }
            }
          });
        }
        if (body.query.includes('WorkTrackerLinearUpdateStatus')) {
          return jsonResponse({
            data: {
              issueUpdate: {
                success: true,
                issue: {
                  ...linearIssue(),
                  state: {
                    id: 'state-done',
                    name: 'Shipped',
                    type: 'completed'
                  }
                }
              }
            }
          });
        }
        throw new Error('Unexpected Linear query');
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLinearAdapter({
      enabled: true,
      apiKey: 'lin_test',
      teamKey: 'ENG'
    });

    await expect(adapter.statusOptions('issue-id')).resolves.toEqual([
      {
        id: 'state-started',
        name: 'In Progress',
        stateCategory: 'in_progress',
        current: true
      },
      {
        id: 'state-done',
        name: 'Shipped',
        stateCategory: 'done',
        current: false
      }
    ]);
    await expect(
      adapter.updateStatus('issue-id', 'state-done')
    ).resolves.toMatchObject({ status: 'Shipped', stateCategory: 'done' });
    await expect(
      adapter.updateStatus('issue-id', 'state-unknown')
    ).rejects.toThrow('not available');
    expect(
      fetchMock.mock.calls.some(([, init]) => {
        const body = JSON.parse(String(init?.body)) as { variables?: unknown };
        return JSON.stringify(body.variables).includes('state-done');
      })
    ).toBe(true);
  });
});

describe('GitHub adapter', () => {
  it('reuses the official GitHub plugin and validates its RPC output', async () => {
    const host = createFakePluginHost({
      pluginId: 'work-tracker-github-test',
      sdk: {
        plugins: {
          callRpc: async ({ method }) => {
            if (method === 'status') {
              return {
                ghOk: true,
                ghError: null,
                repos: [
                  { repo: 'get-bb/bb', projectId: 'proj_bb' },
                  { repo: 'other/repo', projectId: 'proj_other' }
                ],
                lastSyncedAt: null
              };
            }
            if (method === 'listItems') {
              return {
                items: [
                  {
                    repo: 'get-bb/bb',
                    number: 42,
                    kind: 'issue',
                    title: 'External tracker',
                    state: 'OPEN',
                    author: 'mateo',
                    labels: ['feature'],
                    assignees: ['mateo'],
                    url: 'https://github.com/get-bb/bb/issues/42',
                    body: 'Build it.',
                    updatedAt: '2026-08-10T12:00:00.000Z'
                  }
                ]
              };
            }
            throw new Error(`Unexpected method ${method}`);
          }
        }
      }
    });
    try {
      const adapter = createGithubAdapter(host.bb, true, 'proj_bb');

      await expect(adapter.list()).resolves.toEqual([
        expect.objectContaining({
          source: 'github',
          locator: 'get-bb/bb#42',
          key: 'get-bb/bb#42',
          stateCategory: 'todo',
          assignee: 'mateo'
        })
      ]);
      expect(host.harness.sdk.callsTo('plugins.callRpc')).toHaveLength(2);
      expect(host.harness.sdk.callsTo('plugins.callRpc')[1]?.[0]).toMatchObject(
        { input: { repo: 'get-bb/bb' } }
      );
    } finally {
      await host.harness.dispose();
    }
  });

  it('uses the official GitHub state mutation and reloads the issue', async () => {
    let state = 'OPEN';
    const host = createFakePluginHost({
      pluginId: 'work-tracker-github-status-test',
      sdk: {
        plugins: {
          callRpc: async ({ method, input }) => {
            if (method === 'status') {
              return {
                ghOk: true,
                ghError: null,
                repos: [{ repo: 'get-bb/bb', projectId: 'proj_bb' }],
                lastSyncedAt: null
              };
            }
            if (method === 'getIssue') {
              return {
                issue: {
                  repo: 'get-bb/bb',
                  number: 42,
                  title: 'External tracker',
                  state,
                  author: 'mateo',
                  labels: [],
                  assignees: [],
                  url: 'https://github.com/get-bb/bb/issues/42',
                  body: '',
                  updatedAt: '2026-08-10T12:00:00.000Z',
                  comments: []
                }
              };
            }
            if (method === 'setIssueState') {
              expect(input).toEqual({
                repo: 'get-bb/bb',
                number: 42,
                state: 'closed'
              });
              state = 'CLOSED';
              return { ok: true };
            }
            throw new Error(`Unexpected method ${method}`);
          }
        }
      }
    });
    try {
      const adapter = createGithubAdapter(host.bb, true, 'proj_bb');
      await expect(
        adapter.statusOptions('get-bb/bb#42')
      ).resolves.toMatchObject([
        { id: 'open', name: 'Open', current: true },
        { id: 'closed', name: 'Closed', current: false }
      ]);
      await expect(
        adapter.updateStatus('get-bb/bb#42', 'closed')
      ).resolves.toMatchObject({ status: 'CLOSED', stateCategory: 'done' });
    } finally {
      await host.harness.dispose();
    }
  });
});

describe('Jira adapter', () => {
  it('refuses to send Jira credentials to a non-HTTPS URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createJiraAdapter({
      enabled: true,
      baseUrl: 'http://jira.example.com',
      email: 'mateo@example.com',
      apiToken: 'jira-token',
      jql: 'project = BB'
    });

    expect(adapter.configured()).toBe(false);
    expect(adapter.configurationMessage()).toContain('HTTPS');
    await expect(adapter.list()).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses non-Atlassian hosts and non-origin Jira URLs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const baseUrl of [
      'https://jira.example.com',
      'https://example.atlassian.net/proxy',
      'https://example.atlassian.net?redirect=other',
      'https://example.atlassian.net:8443'
    ]) {
      const adapter = createJiraAdapter({
        enabled: true,
        baseUrl,
        email: 'mateo@example.com',
        apiToken: 'jira-token',
        jql: 'project = BB'
      });
      expect(adapter.configured()).toBe(false);
      await expect(adapter.list()).rejects.toThrow('not configured');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes Atlassian document content and sends a scoped JQL search', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          issues: [
            {
              id: '10007',
              key: 'BB-7',
              fields: {
                summary: 'Connect Jira',
                description: {
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Jira description' }]
                    }
                  ]
                },
                updated: '2026-08-10T12:00:00.000Z',
                status: {
                  id: 'status-progress',
                  name: 'In Progress',
                  statusCategory: { key: 'indeterminate' }
                },
                priority: { name: 'High' },
                assignee: { displayName: 'Mateo' },
                project: { key: 'BB', name: 'BB' },
                labels: ['integration']
              }
            }
          ]
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createJiraAdapter({
      enabled: true,
      baseUrl: 'https://example.atlassian.net/',
      email: 'mateo@example.com',
      apiToken: '  jira-token  ',
      jql: 'assignee = currentUser() ORDER BY updated DESC'
    });

    await expect(adapter.list()).resolves.toEqual([
      expect.objectContaining({
        source: 'jira',
        locator: 'BB-7',
        description: 'Jira description',
        stateCategory: 'in_progress',
        url: 'https://example.atlassian.net/browse/BB-7'
      })
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.atlassian.net/rest/api/3/search/jql');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      jql: 'assignee = currentUser() ORDER BY updated DESC',
      maxResults: 100
    });
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('mateo@example.com:jira-token').toString('base64')}`
    });
    expect(init?.redirect).toBe('error');
  });

  it('loads every search page with the trimmed next-page token', async () => {
    let page = 0;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        page += 1;
        return jsonResponse(
          page === 1
            ? {
                issues: [
                  {
                    id: '10007',
                    key: 'BB-7',
                    fields: {
                      summary: 'First issue',
                      description: null,
                      updated: '2026-08-10T12:00:00.000Z',
                      status: {
                        id: 'status-todo',
                        name: 'To Do',
                        statusCategory: { key: 'new' }
                      },
                      priority: null,
                      assignee: null,
                      project: { key: 'BB', name: 'BB' },
                      labels: []
                    }
                  }
                ],
                nextPageToken: '  page-2  '
              }
            : {
                issues: [
                  {
                    id: '10008',
                    key: 'BB-8',
                    fields: {
                      summary: 'Second issue',
                      description: null,
                      updated: '2026-08-10T13:00:00.000Z',
                      status: {
                        id: 'status-progress',
                        name: 'In Progress',
                        statusCategory: { key: 'indeterminate' }
                      },
                      priority: null,
                      assignee: null,
                      project: { key: 'BB', name: 'BB' },
                      labels: []
                    }
                  }
                ]
              }
        );
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createJiraAdapter({
      enabled: true,
      baseUrl: 'https://example.atlassian.net',
      email: 'mateo@example.com',
      apiToken: 'jira-token',
      jql: 'project = BB ORDER BY updated DESC'
    });

    const items = await adapter.list();

    expect(items.map(item => item.key)).toEqual(['BB-7', 'BB-8']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    ).not.toHaveProperty('nextPageToken');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject(
      { nextPageToken: 'page-2' }
    );
  });

  it('rejects a detail that does not match the configured JQL', async () => {
    let request = 0;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        request += 1;
        return jsonResponse(
          request === 1
            ? {
                id: '10007',
                key: 'BB-7',
                fields: {
                  summary: 'Outside this project',
                  description: null,
                  updated: '2026-08-10T12:00:00.000Z',
                  status: {
                    id: 'status-todo',
                    name: 'To Do',
                    statusCategory: { key: 'new' }
                  },
                  priority: null,
                  assignee: null,
                  project: { key: 'OTHER', name: 'Other' },
                  labels: []
                }
              }
            : {
                matches: [{ matchedIssues: [], errors: [] }]
              }
        );
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createJiraAdapter({
      enabled: true,
      baseUrl: 'https://example.atlassian.net',
      email: 'mateo@example.com',
      apiToken: 'jira-token',
      jql: 'project = BB ORDER BY updated DESC'
    });

    await expect(adapter.get('BB-7')).rejects.toThrow(
      'outside the configured scope'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'https://example.atlassian.net/rest/api/3/jql/match'
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      issueIds: [10007],
      jqls: ['project = BB ORDER BY updated DESC']
    });
  });

  it('revalidates Jira transitions and posts the private transition id', async () => {
    let status = {
      id: 'status-todo',
      name: 'To Do',
      statusCategory: { key: 'new' }
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/rest/api/3/jql/match')) {
          return jsonResponse({
            matches: [{ matchedIssues: [10007], errors: [] }]
          });
        }
        if (url.endsWith('/rest/api/3/issue/BB-7/transitions')) {
          if (init?.method === 'POST') {
            expect(JSON.parse(String(init.body))).toEqual({
              transition: { id: '31' }
            });
            status = {
              id: 'status-done',
              name: 'Released',
              statusCategory: { key: 'done' }
            };
            return new Response(null, { status: 204 });
          }
          return jsonResponse({
            transitions: [
              {
                id: '31',
                name: 'Ship it',
                to: {
                  id: 'status-done',
                  name: 'Released',
                  statusCategory: { key: 'done' }
                }
              }
            ]
          });
        }
        if (url.includes('/rest/api/3/issue/BB-7?fields=')) {
          return jsonResponse({
            id: '10007',
            key: 'BB-7',
            fields: {
              summary: 'Connect Jira',
              description: null,
              updated: '2026-08-10T12:00:00.000Z',
              status,
              priority: null,
              assignee: null,
              project: { key: 'BB', name: 'BB' },
              labels: []
            }
          });
        }
        throw new Error(`Unexpected Jira request ${url}`);
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createJiraAdapter({
      enabled: true,
      baseUrl: 'https://example.atlassian.net',
      email: 'mateo@example.com',
      apiToken: 'jira-token',
      jql: 'project = BB'
    });

    await expect(adapter.statusOptions('BB-7')).resolves.toEqual([
      {
        id: 'status-todo',
        name: 'To Do',
        stateCategory: 'todo',
        current: true
      },
      {
        id: 'status-done',
        name: 'Released',
        stateCategory: 'done',
        current: false
      }
    ]);
    await expect(
      adapter.updateStatus('BB-7', 'status-done')
    ).resolves.toMatchObject({ status: 'Released', stateCategory: 'done' });
    await expect(
      adapter.updateStatus('BB-7', 'status-unknown')
    ).rejects.toThrow('not available');
  });
});
