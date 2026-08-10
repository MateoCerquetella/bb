// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPluginApp, renderSlot } from '@bb/plugin-sdk/testing/app';
import type {
  ProjectConfigMutation,
  ProjectConfigView,
  TrackerProject,
  WorkItem,
  WorkItemDetail,
  WorkStatusOption
} from './contract.js';

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  });
}

const app = await loadPluginApp(() => import('./app.js'));

const PROJECT_ALPHA = 'proj_alpha';
const PROJECT_BETA = 'proj_beta';

const projects: TrackerProject[] = [
  { id: PROJECT_ALPHA, name: 'Alpha' },
  { id: PROJECT_BETA, name: 'Beta' }
];

const githubWorkItem: WorkItem = {
  bbProjectId: PROJECT_ALPHA,
  source: 'github',
  locator: 'get-bb/bb#314',
  key: 'get-bb/bb#314',
  title: 'Unify external work',
  description: 'Show this issue in BB.',
  url: 'https://github.com/get-bb/bb/issues/314',
  status: 'OPEN',
  stateCategory: 'todo',
  priority: 'High',
  assignee: 'mateo',
  project: 'get-bb/bb',
  labels: ['tracker', 'platform', 'third-hidden-label'],
  updatedAt: '2026-08-10T12:00:00.000Z'
};

const linearWorkItem: WorkItem = {
  ...githubWorkItem,
  source: 'linear',
  locator: 'lin_alpha_42',
  key: 'ALPHA-42',
  title: 'Align the shared issue hierarchy',
  url: 'https://linear.app/alpha/issue/ALPHA-42',
  status: 'Triage',
  stateCategory: 'todo',
  priority: 'Medium',
  assignee: 'Maya',
  project: 'ALPHA',
  labels: ['design', 'cross-provider']
};

const betaJiraWorkItem: WorkItem = {
  ...githubWorkItem,
  bbProjectId: PROJECT_BETA,
  source: 'jira',
  locator: 'BETA-9',
  key: 'BETA-9',
  title: 'Beta release checklist',
  url: 'https://beta.atlassian.net/browse/BETA-9',
  status: 'In Progress',
  stateCategory: 'in_progress',
  project: 'BETA'
};

const lowJiraWorkItem: WorkItem = {
  ...betaJiraWorkItem,
  bbProjectId: PROJECT_ALPHA,
  locator: 'ALPHA-9',
  key: 'ALPHA-9',
  title: 'Document compact metadata',
  priority: 'Low',
  assignee: 'Sam Rivera',
  project: 'ALPHA'
};

const urgentGithubWorkItem: WorkItem = {
  ...githubWorkItem,
  locator: 'get-bb/bb#315',
  key: 'get-bb/bb#315',
  title: 'Resolve an urgent issue',
  priority: 'Urgent',
  assignee: 'Ana María'
};

const customPriorityLinearWorkItem: WorkItem = {
  ...linearWorkItem,
  locator: 'lin_alpha_43',
  key: 'ALPHA-43',
  title: 'Preserve provider priority text',
  priority: 'Expedite',
  assignee: 'Unassigned'
};

const githubItem: WorkItemDetail = {
  ...githubWorkItem,
  comments: [
    {
      author: 'reviewer',
      body: 'Ready to test.',
      createdAt: '2026-08-10T12:05:00.000Z'
    }
  ]
};

const githubStatuses: WorkStatusOption[] = [
  { id: 'open', name: 'Open', stateCategory: 'todo', current: true },
  { id: 'closed', name: 'Closed', stateCategory: 'done', current: false }
];

const projectConfig: ProjectConfigView = {
  projectId: PROJECT_ALPHA,
  githubEnabled: true,
  githubRepos: ['get-bb/bb'],
  linearEnabled: true,
  linearTeamKey: 'ENG',
  linearCredentialConfigured: true,
  jiraEnabled: true,
  jiraBaseUrl: 'https://alpha.atlassian.net',
  jiraEmail: 'alpha@example.com',
  jiraJql: 'project = "ALPHA"',
  jiraCredentialConfigured: true
};

function seededRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({ projects }),
    listItems: () => ({ items: [githubWorkItem] }),
    refresh: () => ({ sources: [], itemCount: 1 }),
    getItem: () => ({ item: githubItem }),
    statusOptions: () => ({ options: githubStatuses }),
    updateItemStatus: ({ statusId }: { statusId: string }) => ({
      item:
        statusId === 'closed'
          ? {
              ...githubWorkItem,
              status: 'Closed',
              stateCategory: 'done' as const
            }
          : githubWorkItem
    }),
    getProjectConfig: ({ projectId }: { projectId: string }) => ({
      config: { ...projectConfig, projectId }
    }),
    saveProjectConfig: (input: ProjectConfigMutation) => ({
      config: {
        projectId: input.projectId,
        githubEnabled: input.githubEnabled,
        githubRepos: projectConfig.githubRepos,
        linearEnabled: input.linearEnabled,
        linearTeamKey: input.linearTeamKey,
        linearCredentialConfigured:
          input.linearCredential.operation === 'clear' ? false : true,
        jiraEnabled: input.jiraEnabled,
        jiraBaseUrl: input.jiraBaseUrl,
        jiraEmail: input.jiraEmail,
        jiraJql: input.jiraJql,
        jiraCredentialConfigured:
          input.jiraCredential.operation === 'clear' ? false : true
      }
    }),
    ...overrides
  };
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('Work Tracker panel', () => {
  it('registers project Manage and the secure credential renderer', () => {
    expect(app.navPanels[0]).toMatchObject({
      id: 'tracker',
      title: 'Work Tracker',
      path: 'tracker',
      icon: 'ListTodo'
    });
    expect(app.navPanels[0]?.headerContent).toBeTypeOf('function');
    expect(app.settingsSections[0]).toMatchObject({
      id: 'connections',
      title: 'Project connections'
    });
    expect(app.pendingInteractions[0]).toMatchObject({
      id: 'work-tracker-credentials'
    });
  });

  it('opens on the live BB project without first loading an aggregate', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: '' },
      {
        context: { projectId: PROJECT_BETA },
        rpc: seededRpc({
          listItems: ({ projectId }: { projectId?: string }) => ({
            items: projectId === PROJECT_BETA ? [betaJiraWorkItem] : []
          })
        })
      }
    );

    await slot.findByText('Beta release checklist');
    expect(slot.navigateCalls).toContainEqual({
      method: 'toPluginPanel',
      path: 'tracker',
      options: { subPath: PROJECT_BETA, replace: true }
    });
    expect(slot.rpcCalls).toContainEqual({
      method: 'listItems',
      input: { projectId: PROJECT_BETA }
    });
    expect(slot.rpcCalls).not.toContainEqual({
      method: 'listItems',
      input: {}
    });
  });

  it('restores the last live project when global navigation has no project context', async () => {
    window.localStorage.setItem('bb-work-tracker:last-project', PROJECT_BETA);
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: '' },
      {
        rpc: seededRpc({
          listItems: ({ projectId }: { projectId?: string }) => ({
            items: projectId === PROJECT_BETA ? [betaJiraWorkItem] : []
          })
        })
      }
    );

    await slot.findByText('Beta release checklist');
    expect(slot.navigateCalls).toContainEqual({
      method: 'toPluginPanel',
      path: 'tracker',
      options: { subPath: PROJECT_BETA, replace: true }
    });
    expect(slot.rpcCalls).not.toContainEqual({
      method: 'listItems',
      input: {}
    });
  });

  it('uses compact priority and assignee icons in List rows', async () => {
    const emptyMetadataItem: WorkItem = {
      ...betaJiraWorkItem,
      bbProjectId: PROJECT_ALPHA,
      locator: 'ALPHA-10',
      key: 'ALPHA-10',
      title: 'Keep empty metadata quiet',
      priority: 'No priority',
      assignee: 'Unassigned'
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      {
        rpc: seededRpc({
          listItems: () => ({
            items: [githubWorkItem, lowJiraWorkItem, emptyMetadataItem]
          })
        })
      }
    );

    await slot.findByText('Unify external work');
    const highRow = slot.getByRole('button', {
      name: /^Open get-bb\/bb#314: Unify external work\./
    });
    expect(highRow.getAttribute('aria-label')).toContain('Priority High');
    expect(highRow.getAttribute('aria-label')).toContain('Assigned to mateo');
    expect(within(highRow).queryByText('High')).toBeNull();
    expect(within(highRow).queryByText('mateo')).toBeNull();
    const highPriority = highRow.querySelector('.wt-priority-mark');
    expect(highPriority?.getAttribute('data-priority-tone')).toBe('high');
    expect(highPriority?.getAttribute('data-priority-icon')).toBe('ChevronsUp');
    const mateoMark = highRow.querySelector('.wt-assignee-mark');
    expect(mateoMark?.textContent).toBe('M');
    fireEvent.pointerMove(mateoMark!);
    expect(
      (await slot.findAllByText('Assigned to mateo')).length
    ).toBeGreaterThan(0);
    fireEvent.pointerMove(highPriority!);
    expect((await slot.findAllByText('Priority: High')).length).toBeGreaterThan(
      0
    );

    const lowRow = slot.getByRole('button', {
      name: /^Open ALPHA-9: Document compact metadata\./
    });
    expect(
      lowRow
        .querySelector('.wt-priority-mark')
        ?.getAttribute('data-priority-icon')
    ).toBe('ChevronsDown');
    expect(lowRow.querySelector('.wt-assignee-mark')?.textContent).toBe('SR');

    const emptyRow = slot.getByRole('button', {
      name: /^Open ALPHA-10: Keep empty metadata quiet\./
    });
    expect(emptyRow.querySelector('.wt-priority-mark')).toBeNull();
    expect(emptyRow.querySelector('.wt-assignee-mark')).toBeNull();
    expect(emptyRow.getAttribute('aria-label')).not.toContain('No priority');
    expect(emptyRow.getAttribute('aria-label')).not.toContain('Unassigned');
  });

  it('keeps Projects first, Across projects explicit, and connector counters absent', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      { rpc: seededRpc() }
    );

    await slot.findByText('Unify external work');
    const navigation = slot.getByRole('navigation', {
      name: 'Work Tracker navigation'
    });
    const buttons = within(navigation).getAllByRole('button');
    expect(buttons.map(button => button.textContent?.trim())).toEqual([
      'Alpha',
      'Beta',
      'Across projects'
    ]);
    expect(within(navigation).queryByText('Linear')).toBeNull();
    expect(within(navigation).queryByText('GitHub')).toBeNull();
    expect(within(navigation).queryByText('Jira')).toBeNull();
    expect(slot.queryByText(/1 item/)).toBeNull();

    fireEvent.click(
      within(navigation).getByRole('button', { name: 'Across projects' })
    );
    expect(slot.navigateCalls).toContainEqual({
      method: 'toPluginPanel',
      path: 'tracker',
      options: { subPath: 'all' }
    });
  });

  it('groups Across projects by owning BB project', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: 'all' },
      {
        rpc: seededRpc({
          listItems: () => ({ items: [githubWorkItem, betaJiraWorkItem] })
        })
      }
    );

    const alphaHeading = await slot.findByRole('heading', { name: 'Alpha' });
    const betaHeading = slot.getByRole('heading', { name: 'Beta' });
    expect(
      within(alphaHeading.closest('section')!).getByText('Unify external work')
    ).toBeDefined();
    expect(
      within(betaHeading.closest('section')!).getByText(
        'Beta release checklist'
      )
    ).toBeDefined();
    expect(slot.queryByRole('button', { name: 'Kanban' })).toBeNull();
  });

  it('shows mapped GitHub repositories in Manage', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `manage/${PROJECT_ALPHA}` },
      { rpc: seededRpc() }
    );

    await slot.findByText('Mapped repositories for this BB project');
    await slot.findByText('get-bb/bb');
  });

  it('disambiguates duplicate BB project names in Across projects', async () => {
    const duplicateProjects: TrackerProject[] = projects.map(project => ({
      ...project,
      name: 'Shared'
    }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: 'all' },
      {
        rpc: seededRpc({
          listProjects: () => ({ projects: duplicateProjects }),
          listItems: () => ({ items: [githubWorkItem, betaJiraWorkItem] })
        })
      }
    );

    const headings = await slot.findAllByRole('heading', { name: /^Shared/ });
    expect(headings).toHaveLength(2);
    expect(headings.map(heading => heading.textContent)).toEqual([
      `Shared${PROJECT_ALPHA}`,
      `Shared${PROJECT_BETA}`
    ]);
  });

  it('searches live and keeps a newer result when an older request resolves late', async () => {
    let resolveInitial: ((value: { items: WorkItem[] }) => void) | undefined;
    const freshItem: WorkItem = {
      ...githubWorkItem,
      locator: 'get-bb/bb#315',
      key: 'get-bb/bb#315',
      title: 'Fresh filtered work'
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      {
        rpc: seededRpc({
          listItems: (input: { query?: string }) => {
            if (input.query === 'fresh') return { items: [freshItem] };
            return new Promise<{ items: WorkItem[] }>(resolve => {
              resolveInitial = resolve;
            });
          }
        })
      }
    );

    await waitFor(() => expect(resolveInitial).toBeTypeOf('function'));
    fireEvent.change(slot.getByLabelText('Search work items'), {
      target: { value: 'fresh' }
    });
    await slot.findByText('Fresh filtered work');
    expect(slot.rpcCalls).toContainEqual({
      method: 'listItems',
      input: { projectId: PROJECT_ALPHA, query: 'fresh' }
    });

    await act(async () => {
      resolveInitial?.({
        items: [{ ...githubWorkItem, title: 'Stale unfiltered work' }]
      });
    });
    expect(slot.getByText('Fresh filtered work')).toBeDefined();
    expect(slot.queryByText('Stale unfiltered work')).toBeNull();
  });

  it('uses actual external statuses as compact Kanban lanes and opens cards', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      {
        rpc: seededRpc({
          listItems: (input: { query?: string }) => ({
            items: input.query
              ? []
              : [
                  githubWorkItem,
                  linearWorkItem,
                  lowJiraWorkItem,
                  urgentGithubWorkItem,
                  customPriorityLinearWorkItem,
                  {
                    ...betaJiraWorkItem,
                    bbProjectId: PROJECT_ALPHA,
                    priority: 'No priority',
                    assignee: 'Unassigned',
                    labels: []
                  }
                ]
          })
        })
      }
    );

    await slot.findByText('Unify external work');
    fireEvent.click(slot.getByRole('button', { name: 'Kanban' }));
    const board = slot.getByRole('region', { name: 'Kanban board' });
    expect(within(board).getByRole('heading', { name: 'OPEN' })).toBeDefined();
    expect(
      within(board).getByRole('heading', { name: 'In Progress' })
    ).toBeDefined();
    expect(
      within(board).queryByRole('heading', { name: 'Backlog' })
    ).toBeNull();
    expect(
      within(board).queryByRole('heading', { name: 'Canceled' })
    ).toBeNull();
    const card = within(board).getByRole('button', {
      name: /^get-bb\/bb#314: Unify external work\./
    });
    expect(card.getAttribute('draggable')).toBe('true');
    expect(card.getAttribute('aria-label')).toContain('Source GitHub');
    expect(within(card).getByText('GitHub')).toBeDefined();
    expect(within(card).queryByText('OPEN')).toBeNull();
    expect(within(card).getByText('tracker')).toBeDefined();
    expect(within(card).getByText('platform')).toBeDefined();
    expect(within(card).queryByText('third-hidden-label')).toBeNull();
    expect(within(card).getByText('Updated Aug 10')).toBeDefined();
    expect(card.querySelectorAll('.wt-state-dot')).toHaveLength(1);
    expect(card.getAttribute('aria-label')).toContain('Priority High');
    expect(card.getAttribute('aria-label')).toContain('Assigned to mateo');
    expect(within(card).queryByText('High')).toBeNull();
    expect(within(card).queryByText('mateo')).toBeNull();
    const highPriority = card.querySelector('.wt-priority-mark');
    expect(highPriority?.getAttribute('data-priority-tone')).toBe('high');
    expect(highPriority?.getAttribute('data-priority-icon')).toBe('ChevronsUp');
    const mateoMark = card.querySelector('.wt-assignee-mark');
    expect(mateoMark?.textContent).toBe('M');
    fireEvent.pointerMove(mateoMark!);
    expect(
      (await slot.findAllByText('Assigned to mateo')).length
    ).toBeGreaterThan(0);
    fireEvent.pointerMove(highPriority!);
    expect((await slot.findAllByText('Priority: High')).length).toBeGreaterThan(
      0
    );
    const linearCard = within(board).getByRole('button', {
      name: /^ALPHA-42: Align the shared issue hierarchy\./
    });
    expect(linearCard.className).toContain('wt-kanban-card');
    expect(within(linearCard).getByText('Linear')).toBeDefined();
    expect(within(linearCard).getByText('design')).toBeDefined();
    expect(within(linearCard).getByText('cross-provider')).toBeDefined();
    expect(within(linearCard).getByText('Updated Aug 10')).toBeDefined();
    expect(
      linearCard
        .querySelector('.wt-priority-mark')
        ?.getAttribute('data-priority-tone')
    ).toBe('medium');
    expect(
      linearCard
        .querySelector('.wt-priority-mark')
        ?.getAttribute('data-priority-icon')
    ).toBe('ArrowUpDown');
    const lowJiraCard = within(board).getByRole('button', {
      name: /^ALPHA-9: Document compact metadata\./
    });
    expect(
      lowJiraCard
        .querySelector('.wt-priority-mark')
        ?.getAttribute('data-priority-tone')
    ).toBe('low');
    expect(
      lowJiraCard
        .querySelector('.wt-priority-mark')
        ?.getAttribute('data-priority-icon')
    ).toBe('ChevronsDown');
    expect(lowJiraCard.querySelector('.wt-assignee-mark')?.textContent).toBe(
      'SR'
    );
    const urgentCard = within(board).getByRole('button', {
      name: /^get-bb\/bb#315: Resolve an urgent issue\./
    });
    expect(
      urgentCard
        .querySelector('.wt-priority-mark')
        ?.getAttribute('data-priority-tone')
    ).toBe('urgent');
    expect(
      urgentCard
        .querySelector('.wt-priority-mark')
        ?.getAttribute('data-priority-icon')
    ).toBe('AlertTriangle');
    expect(urgentCard.querySelector('.wt-assignee-mark')?.textContent).toBe(
      'AM'
    );
    const customPriorityCard = within(board).getByRole('button', {
      name: /^ALPHA-43: Preserve provider priority text\./
    });
    const customPriority =
      customPriorityCard.querySelector('.wt-priority-mark');
    expect(customPriority?.getAttribute('data-priority-tone')).toBe('neutral');
    expect(customPriority?.getAttribute('data-priority-icon')).toBe(
      'ChartColumn'
    );
    fireEvent.pointerMove(customPriority!);
    expect(
      (await slot.findAllByText('Priority: Expedite')).length
    ).toBeGreaterThan(0);
    const jiraCard = within(board).getByRole('button', {
      name: /^BETA-9: Beta release checklist\./
    });
    expect(jiraCard.className).toContain('wt-kanban-card');
    expect(within(jiraCard).getByText('Jira')).toBeDefined();
    expect(within(jiraCard).queryByText('In Progress')).toBeNull();
    expect(within(jiraCard).queryByText('No priority')).toBeNull();
    expect(within(jiraCard).queryByText('Unassigned')).toBeNull();
    expect(jiraCard.querySelector('.wt-priority-mark')).toBeNull();
    expect(jiraCard.querySelector('.wt-assignee-mark')).toBeNull();
    expect(jiraCard.querySelectorAll('.wt-label-chip')).toHaveLength(0);
    expect(within(jiraCard).getByText('Updated Aug 10')).toBeDefined();
    fireEvent.click(card);
    expect(slot.navigateCalls).toContainEqual({
      method: 'toPluginPanel',
      path: 'tracker',
      options: {
        subPath: `item/${PROJECT_ALPHA}/github/get-bb~2Fbb~23314`
      }
    });

    fireEvent.change(slot.getByLabelText('Search work items'), {
      target: { value: 'missing' }
    });
    await slot.findByText('No work items match the current filters');
    expect(slot.getByRole('region', { name: 'Kanban board' })).toBeDefined();
    expect(
      slot.getByText('No external statuses in the current results')
    ).toBeDefined();
  });

  it('drags a card to a provider status and keeps the authoritative result', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      { rpc: seededRpc() }
    );

    await slot.findByText('Unify external work');
    fireEvent.click(slot.getByRole('button', { name: 'Kanban' }));
    const card = slot.getByRole('button', {
      name: /^get-bb\/bb#314: Unify external work\./
    });
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'none',
      setData: vi.fn()
    };
    fireEvent.dragStart(card, { dataTransfer });
    const closed = await slot.findByRole('heading', { name: 'Closed' });
    const lane = closed.closest('section');
    expect(lane).not.toBeNull();
    fireEvent.dragOver(lane!, { dataTransfer });
    fireEvent.drop(lane!, { dataTransfer });

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: 'updateItemStatus',
        input: {
          projectId: PROJECT_ALPHA,
          source: 'github',
          locator: 'get-bb/bb#314',
          statusId: 'closed'
        }
      })
    );
    expect(
      slot.getByRole('button', {
        name: /^get-bb\/bb#314: Unify external work\. Status Closed\./
      })
    ).toBeDefined();
    expect(
      slot
        .getAllByRole('status')
        .some(status => status.textContent?.includes('moved to Closed'))
    ).toBe(true);
  });

  it('keeps a fast first drop while connector transitions are loading', async () => {
    let resolveOptions:
      | ((value: { options: WorkStatusOption[] }) => void)
      | undefined;
    const closedItem: WorkItem = {
      ...githubWorkItem,
      locator: 'get-bb/bb#315',
      key: 'get-bb/bb#315',
      title: 'Already closed',
      status: 'Closed',
      stateCategory: 'done'
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      {
        rpc: seededRpc({
          listItems: () => ({ items: [githubWorkItem, closedItem] }),
          statusOptions: () =>
            new Promise<{ options: WorkStatusOption[] }>(resolve => {
              resolveOptions = resolve;
            })
        })
      }
    );

    await slot.findByText('Unify external work');
    fireEvent.click(slot.getByRole('button', { name: 'Kanban' }));
    const card = slot.getByRole('button', {
      name: /^get-bb\/bb#314: Unify external work\./
    });
    const lane = slot
      .getByRole('heading', { name: 'Closed' })
      .closest('section');
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'none',
      setData: vi.fn()
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(lane!, { dataTransfer });
    expect(lane?.getAttribute('data-drop-state')).toBe('checking');
    fireEvent.drop(lane!, { dataTransfer });
    await act(async () => {
      resolveOptions?.({ options: githubStatuses });
    });

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: 'updateItemStatus',
        input: {
          projectId: PROJECT_ALPHA,
          source: 'github',
          locator: 'get-bb/bb#314',
          statusId: 'closed'
        }
      })
    );
  });

  it('supports keyboard status moves and rolls back a rejected provider write', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      {
        rpc: seededRpc({
          updateItemStatus: () => Promise.reject(new Error('Move rejected'))
        })
      }
    );

    await slot.findByText('Unify external work');
    fireEvent.click(slot.getByRole('button', { name: 'Kanban' }));
    const card = slot.getByRole('button', {
      name: /^get-bb\/bb#314: Unify external work\./
    });
    card.focus();
    fireEvent.keyDown(card, { key: ' ' });
    await slot.findByRole('heading', { name: 'Closed' });
    await waitFor(() => expect(card.getAttribute('aria-grabbed')).toBe('true'));
    fireEvent.keyDown(card, { key: 'Enter' });

    await slot.findByRole('alert');
    expect(slot.getByRole('alert').textContent).toContain(
      'stayed in OPEN. Move rejected'
    );
    expect(
      slot.getByRole('button', {
        name: /^get-bb\/bb#314: Unify external work\. Status OPEN\./
      })
    ).toBeDefined();
  });

  it('restores a project browse view and query after visiting details', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      { rpc: seededRpc() }
    );
    await slot.findByText('Unify external work');
    fireEvent.click(slot.getByRole('button', { name: 'Kanban' }));
    fireEvent.change(slot.getByLabelText('Search work items'), {
      target: { value: 'retain me' }
    });
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: 'listItems',
        input: { projectId: PROJECT_ALPHA, query: 'retain me' }
      })
    );
    fireEvent.click(
      slot.getByRole('button', {
        name: /^get-bb\/bb#314: Unify external work\./
      })
    );

    const Panel = app.navPanels[0]!.component;
    slot.lifecycle.rerender(
      <Panel subPath={`item/${PROJECT_ALPHA}/github/get-bb~2Fbb~23314`} />
    );
    await slot.findByRole('heading', { name: 'Unify external work' });
    slot.lifecycle.rerender(<Panel subPath={PROJECT_ALPHA} />);

    await waitFor(() =>
      expect(slot.getByLabelText('Search work items')).toHaveProperty(
        'value',
        'retain me'
      )
    );
    expect(
      slot.getByRole('button', { name: 'Kanban' }).getAttribute('aria-pressed')
    ).toBe('true');
  });

  it('scopes refresh and detail loading to the selected project', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ALPHA },
      { rpc: seededRpc() }
    );

    await slot.findByText('Unify external work');
    fireEvent.click(slot.getByRole('button', { name: 'Refresh work items' }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: 'refresh',
        input: { projectId: PROJECT_ALPHA }
      })
    );

    const Panel = app.navPanels[0]!.component;
    slot.lifecycle.rerender(
      <Panel subPath={`item/${PROJECT_ALPHA}/github/get-bb~2Fbb~23314`} />
    );
    await slot.findByRole('heading', { name: 'Unify external work' });
    expect(slot.rpcCalls).toContainEqual({
      method: 'getItem',
      input: {
        projectId: PROJECT_ALPHA,
        source: 'github',
        locator: 'get-bb/bb#314'
      }
    });
  });

  it('keeps Manage project-bound, saves write-only mutations, and clears drafts', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: 'manage' },
      { context: { projectId: PROJECT_ALPHA }, rpc: seededRpc() }
    );

    await slot.findByDisplayValue('ENG');
    expect(slot.rpcCalls).toContainEqual({
      method: 'getProjectConfig',
      input: { projectId: PROJECT_ALPHA }
    });
    expect(slot.navigateCalls).toContainEqual({
      method: 'toPluginPanel',
      path: 'tracker',
      options: { subPath: `manage/${PROJECT_ALPHA}`, replace: true }
    });
    expect(slot.getAllByText('Configured')).toHaveLength(2);
    expect(slot.queryByLabelText('GitHub token')).toBeNull();

    const linearSwitch = slot.getByRole('switch', {
      name: 'Include Linear issues'
    });
    fireEvent.click(
      slot.getByRole('button', { name: 'Remove Linear credential' })
    );
    await waitFor(() =>
      expect(linearSwitch.getAttribute('aria-checked')).toBe('false')
    );
    fireEvent.click(
      slot.getByRole('button', { name: 'Keep Linear credential' })
    );
    await waitFor(() =>
      expect(linearSwitch.getAttribute('aria-checked')).toBe('true')
    );

    const newKey = 'linear-secret-sentinel';
    fireEvent.change(slot.getByLabelText('Linear team key'), {
      target: { value: 'CORE' }
    });
    fireEvent.change(slot.getByLabelText('Linear API key'), {
      target: { value: newKey }
    });
    expect(slot.container.textContent).not.toContain(newKey);
    fireEvent.click(
      slot.getByRole('button', { name: 'Save project connection' })
    );

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: 'saveProjectConfig',
        input: {
          projectId: PROJECT_ALPHA,
          githubEnabled: true,
          linearEnabled: true,
          linearTeamKey: 'CORE',
          linearCredential: { operation: 'set', value: newKey },
          jiraEnabled: true,
          jiraBaseUrl: 'https://alpha.atlassian.net',
          jiraEmail: 'alpha@example.com',
          jiraJql: 'project = "ALPHA"',
          jiraCredential: { operation: 'keep' }
        }
      })
    );
    await slot.findByRole('status');
    expect(slot.getByLabelText('Linear API key')).toHaveProperty('value', '');

    fireEvent.change(slot.getByLabelText('Linear API key'), {
      target: { value: 'draft-cleared-on-switch' }
    });
    const Panel = app.navPanels[0]!.component;
    slot.lifecycle.rerender(<Panel subPath={`manage/${PROJECT_BETA}`} />);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: 'getProjectConfig',
        input: { projectId: PROJECT_BETA }
      })
    );
    expect(slot.getByLabelText('Linear API key')).toHaveProperty('value', '');
  });

  it('requires a Linear team and Jira replacement when connector identity changes', async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `manage/${PROJECT_ALPHA}` },
      { rpc: seededRpc() }
    );
    await slot.findByDisplayValue('ENG');

    fireEvent.change(slot.getByLabelText('Linear team key'), {
      target: { value: '' }
    });
    fireEvent.click(
      slot.getByRole('button', { name: 'Save project connection' })
    );
    expect((await slot.findByRole('alert')).textContent).toContain(
      'Linear team key'
    );

    fireEvent.change(slot.getByLabelText('Linear team key'), {
      target: { value: 'ENG' }
    });
    fireEvent.change(slot.getByLabelText('Jira site'), {
      target: { value: 'https://other.atlassian.net' }
    });
    fireEvent.click(
      slot.getByRole('button', { name: 'Save project connection' })
    );
    expect((await slot.findByRole('alert')).textContent).toContain(
      'replacement token'
    );
    expect(
      slot.rpcCalls.filter(call => call.method === 'saveProjectConfig')
    ).toHaveLength(0);
  });

  it('does not let an older project save replace a newly selected project', async () => {
    let resolveSave:
      | ((value: { config: ProjectConfigView }) => void)
      | undefined;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `manage/${PROJECT_ALPHA}` },
      {
        rpc: seededRpc({
          getProjectConfig: ({ projectId }: { projectId: string }) => ({
            config: {
              ...projectConfig,
              projectId,
              linearTeamKey: projectId === PROJECT_BETA ? 'BETA' : 'ENG'
            }
          }),
          saveProjectConfig: () =>
            new Promise<{ config: ProjectConfigView }>(resolve => {
              resolveSave = resolve;
            })
        })
      }
    );
    await slot.findByDisplayValue('ENG');
    fireEvent.change(slot.getByLabelText('Linear API key'), {
      target: { value: 'alpha-in-flight' }
    });
    fireEvent.click(
      slot.getByRole('button', { name: 'Save project connection' })
    );
    await waitFor(() => expect(resolveSave).toBeTypeOf('function'));
    expect(slot.getByLabelText('BB project')).toHaveProperty('disabled', true);

    const Panel = app.navPanels[0]!.component;
    slot.lifecycle.rerender(<Panel subPath={`manage/${PROJECT_BETA}`} />);
    await slot.findByDisplayValue('BETA');
    await act(async () => {
      resolveSave?.({ config: projectConfig });
    });

    expect(slot.getByDisplayValue('BETA')).toBeDefined();
    expect(slot.queryByDisplayValue('ENG')).toBeNull();
    expect(slot.getByLabelText('Linear API key')).toHaveProperty('value', '');
  });

  it('submits bounded write-only credentials from the secure interaction', async () => {
    const submit = vi.fn(async () => undefined);
    const slot = renderSlot(app.pendingInteractions[0]!, {
      interaction: {
        id: 'pint_credentials',
        threadId: 'thr_test',
        title: 'Project credentials',
        payload: {
          projectId: PROJECT_ALPHA,
          projectName: 'Alpha',
          linearTeamKey: 'ENG',
          jiraBaseUrl: 'https://alpha.atlassian.net',
          jiraEmail: 'alpha@example.com',
          linearCredentialConfigured: true,
          jiraCredentialConfigured: false
        },
        createdAt: 0,
        expiresAt: null
      },
      submit,
      cancel: async () => undefined
    });

    const secret = 'interaction-secret-sentinel';
    expect(slot.getByText('ENG')).toBeDefined();
    expect(slot.getByText('https://alpha.atlassian.net')).toBeDefined();
    expect(slot.getByText('alpha@example.com')).toBeDefined();
    fireEvent.change(slot.getByLabelText('Jira API token'), {
      target: { value: secret }
    });
    expect(slot.container.textContent).not.toContain(secret);
    fireEvent.click(slot.getByRole('button', { name: 'Save credentials' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith({
      linearCredential: { operation: 'keep' },
      jiraCredential: { operation: 'set', value: secret }
    });
    expect(submit.mock.calls[0]?.[0]).not.toHaveProperty('projectId');
    await waitFor(() =>
      expect(slot.getByLabelText('Jira API token')).toHaveProperty('value', '')
    );
  });

  it('clears credential drafts when the host reuses the renderer', async () => {
    const registration = app.pendingInteractions[0]!;
    const slot = renderSlot(registration, {
      interaction: {
        id: 'pint_alpha',
        threadId: 'thr_test',
        title: 'Project credentials',
        payload: {
          projectId: PROJECT_ALPHA,
          projectName: 'Alpha',
          linearTeamKey: 'ENG',
          jiraBaseUrl: 'https://alpha.atlassian.net',
          jiraEmail: 'alpha@example.com',
          linearCredentialConfigured: true,
          jiraCredentialConfigured: true
        },
        createdAt: 0,
        expiresAt: null
      },
      submit: async () => undefined,
      cancel: async () => undefined
    });
    fireEvent.change(slot.getByLabelText('Linear API key'), {
      target: { value: 'must-not-cross-projects' }
    });

    const Interaction = registration.component;
    slot.lifecycle.rerender(
      <Interaction
        interaction={{
          id: 'pint_beta',
          threadId: 'thr_test',
          title: 'Project credentials',
          payload: {
            projectId: PROJECT_BETA,
            projectName: 'Beta',
            linearTeamKey: 'CORE',
            jiraBaseUrl: '',
            jiraEmail: '',
            linearCredentialConfigured: false,
            jiraCredentialConfigured: false
          },
          createdAt: 1,
          expiresAt: null
        }}
        submit={async () => undefined}
        cancel={async () => undefined}
      />
    );

    await waitFor(() =>
      expect(slot.getByLabelText('Linear API key')).toHaveProperty('value', '')
    );
    expect(slot.getByText('CORE')).toBeDefined();
    expect(slot.getAllByText('Not configured').length).toBeGreaterThanOrEqual(
      2
    );
  });

  it('lets an invalid secure interaction be canceled', () => {
    const cancel = vi.fn(async () => undefined);
    const slot = renderSlot(app.pendingInteractions[0]!, {
      interaction: {
        id: 'pint_invalid',
        threadId: 'thr_test',
        title: 'Project credentials',
        payload: { projectId: 'invalid' },
        createdAt: 0,
        expiresAt: null
      },
      submit: async () => undefined,
      cancel
    });
    expect(slot.getByRole('alert').textContent).toContain('invalid');
    fireEvent.click(slot.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
