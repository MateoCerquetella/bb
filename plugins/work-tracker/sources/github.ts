import type { BbPluginApi } from '@bb/plugin-sdk';
import { z } from 'zod';
import type {
  ExternalWorkItemDetail,
  ExternalWorkStatusOption,
  WorkSourceAdapter
} from './types.js';
import { withoutComments } from './types.js';

const githubItemSchema = z
  .object({
    repo: z.string(),
    number: z.number().int().positive(),
    kind: z.enum(['issue', 'pr']),
    title: z.string(),
    state: z.string(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string()
  })
  .strict();

const listOutputSchema = z
  .object({ items: z.array(githubItemSchema) })
  .strict();

const detailOutputSchema = z
  .object({
    issue: githubItemSchema
      .omit({ kind: true })
      .extend({
        comments: z.array(
          z
            .object({
              author: z.string(),
              body: z.string(),
              createdAt: z.string()
            })
            .strict()
        )
      })
      .strict()
  })
  .strict();

export const githubStatusOutputSchema = z
  .object({
    ghOk: z.boolean(),
    ghError: z.string().nullable(),
    repos: z.array(
      z.object({ repo: z.string(), projectId: z.string().nullable() }).strict()
    ),
    lastSyncedAt: z.string().nullable()
  })
  .strict();

const refreshOutputSchema = z
  .object({
    repos: z.number().int().nonnegative(),
    items: z.number().int().nonnegative()
  })
  .strict();

const okOutputSchema = z.object({ ok: z.literal(true) }).strict();

const activeRefreshes = new WeakMap<BbPluginApi, Promise<void>>();

function refreshGithubCache(bb: BbPluginApi): Promise<void> {
  const active = activeRefreshes.get(bb);
  if (active) return active;
  const promise = bb.sdk.plugins
    .callRpc({
      pluginId: 'github',
      method: 'refresh',
      input: null,
      outputSchema: refreshOutputSchema
    })
    .then(() => undefined)
    .finally(() => {
      if (activeRefreshes.get(bb) === promise) activeRefreshes.delete(bb);
    });
  activeRefreshes.set(bb, promise);
  return promise;
}

function githubStatus(bb: BbPluginApi) {
  return bb.sdk.plugins.callRpc({
    pluginId: 'github',
    method: 'status',
    input: null,
    outputSchema: githubStatusOutputSchema
  });
}

export type GithubStatus = z.infer<typeof githubStatusOutputSchema>;

export function githubReposForProject(
  status: GithubStatus,
  projectId: string
): string[] {
  return [
    ...new Set(
      status.repos
        .filter(repo => repo.projectId === projectId)
        .map(repo => repo.repo)
    )
  ];
}

function toItem(
  value: z.infer<typeof githubItemSchema>,
  comments: ExternalWorkItemDetail['comments'] = []
): ExternalWorkItemDetail {
  const open = value.state.toLowerCase() === 'open';
  return {
    source: 'github',
    locator: `${value.repo}#${value.number}`,
    key: `${value.repo}#${value.number}`,
    title: value.title,
    description: value.body,
    url: value.url,
    status: value.state,
    stateCategory: open ? 'todo' : 'done',
    priority: null,
    assignee: value.assignees.join(', ') || null,
    project: value.repo,
    labels: value.labels,
    updatedAt: value.updatedAt,
    comments
  };
}

function parseLocator(locator: string): { repo: string; number: number } {
  const match = /^(?<repo>[^#]+)#(?<number>[1-9]\d*)$/u.exec(locator);
  if (!match?.groups)
    throw new Error(`Invalid GitHub issue locator: ${locator}`);
  return { repo: match.groups.repo!, number: Number(match.groups.number) };
}

export function createGithubAdapter(
  bb: BbPluginApi,
  enabled: boolean,
  projectId: string
): WorkSourceAdapter {
  async function scopedIssue(locator: string): Promise<ExternalWorkItemDetail> {
    const { repo, number } = parseLocator(locator);
    const status = await githubStatus(bb);
    if (!status.ghOk) {
      throw new Error(status.ghError ?? 'GitHub is not authenticated');
    }
    if (!githubReposForProject(status, projectId).includes(repo)) {
      throw new Error(
        `GitHub repository ${repo} is not mapped to BB project ${projectId}`
      );
    }
    const result = await bb.sdk.plugins.callRpc({
      pluginId: 'github',
      method: 'getIssue',
      input: { repo, number },
      outputSchema: detailOutputSchema
    });
    if (result.issue.repo !== repo || result.issue.number !== number) {
      throw new Error(`GitHub returned the wrong issue for ${locator}`);
    }
    return toItem({ ...result.issue, kind: 'issue' }, result.issue.comments);
  }

  async function statusOptions(
    locator: string
  ): Promise<ExternalWorkStatusOption[]> {
    const issue = await scopedIssue(locator);
    const current = issue.status.toLowerCase() === 'open' ? 'open' : 'closed';
    return [
      {
        id: 'open',
        name: 'Open',
        stateCategory: 'todo',
        current: current === 'open'
      },
      {
        id: 'closed',
        name: 'Closed',
        stateCategory: 'done',
        current: current === 'closed'
      }
    ];
  }

  return {
    source: 'github',
    configured: () => enabled,
    configurationMessage: () =>
      enabled ? null : 'Enable GitHub in Work Tracker settings.',
    async list(options) {
      if (!enabled) throw new Error('GitHub is disabled');
      if (options?.refresh) await refreshGithubCache(bb);
      const status = await githubStatus(bb);
      if (!status.ghOk) {
        throw new Error(status.ghError ?? 'GitHub is not authenticated');
      }
      const repos = githubReposForProject(status, projectId);
      const results = await Promise.all(
        repos.map(async repo => ({
          repo,
          result: await bb.sdk.plugins.callRpc({
            pluginId: 'github',
            method: 'listItems',
            input: { kind: 'issue', repo },
            outputSchema: listOutputSchema
          })
        }))
      );
      return results.flatMap(({ repo, result }) =>
        result.items.map(item => {
          if (item.repo !== repo || item.kind !== 'issue') {
            throw new Error(
              `GitHub returned an item outside requested repository ${repo}`
            );
          }
          return withoutComments(toItem(item));
        })
      );
    },
    async get(locator) {
      if (!enabled) throw new Error('GitHub is disabled');
      return scopedIssue(locator);
    },
    async statusOptions(locator) {
      if (!enabled) throw new Error('GitHub is disabled');
      return statusOptions(locator);
    },
    async updateStatus(locator, statusId) {
      if (!enabled) throw new Error('GitHub is disabled');
      const available = await statusOptions(locator);
      const target = available.find(option => option.id === statusId);
      if (!target) {
        throw new Error('GitHub status is not available for this issue');
      }
      if (!target.current) {
        const { repo, number } = parseLocator(locator);
        await bb.sdk.plugins.callRpc({
          pluginId: 'github',
          method: 'setIssueState',
          input: { repo, number, state: statusId },
          outputSchema: okOutputSchema
        });
      }
      return scopedIssue(locator);
    }
  };
}
