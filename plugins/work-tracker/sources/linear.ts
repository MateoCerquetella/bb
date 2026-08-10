import { z } from 'zod';
import type { WorkStateCategory } from '../contract.js';
import type {
  ExternalWorkItemDetail,
  ExternalWorkStatusOption,
  WorkSourceAdapter
} from './types.js';
import { withoutComments } from './types.js';

const LINEAR_API = 'https://api.linear.app/graphql';

const issueFields = `
  id
  identifier
  title
  description
  url
  priorityLabel
  updatedAt
  state { id name type }
  assignee { id name }
  team { key name }
  project { name }
  labels(first: 50) { nodes { name } }
`;

const teamIssuesQuery = `
  query TeamIssues($teamKey: String!, $after: String) {
    issues(
      first: 100
      after: $after
      orderBy: updatedAt
      filter: {
        team: { key: { eqIgnoreCase: $teamKey } }
        state: { type: { nin: ["completed", "canceled"] } }
      }
    ) {
      nodes { ${issueFields} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const issueQuery = `
  query WorkTrackerLinearIssue($id: String!) {
    issue(id: $id) {
      ${issueFields}
      comments(first: 50) {
        nodes { body createdAt user { name } }
      }
    }
  }
`;

const issueStatusOptionsQuery = `
  query WorkTrackerLinearStatusOptions($id: String!) {
    issue(id: $id) {
      id
      state { id name type }
      team {
        key
        states { nodes { id name type } }
      }
    }
  }
`;

const updateIssueStatusMutation = `
  mutation WorkTrackerLinearUpdateStatus($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { ${issueFields} }
    }
  }
`;

const namedSchema = z.object({ name: z.string() }).strict();
const assigneeSchema = z
  .object({ id: z.string().min(1), name: z.string() })
  .strict();
const stateSchema = z
  .object({ id: z.string().min(1), name: z.string(), type: z.string() })
  .strict();
const issueSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
    url: z.string(),
    priorityLabel: z.string(),
    updatedAt: z.string(),
    state: stateSchema,
    assignee: assigneeSchema.nullable(),
    team: z.object({ key: z.string(), name: z.string() }).strict(),
    project: namedSchema.nullable(),
    labels: z.object({ nodes: z.array(namedSchema) }).strict(),
    comments: z
      .object({
        nodes: z.array(
          z
            .object({
              body: z.string(),
              createdAt: z.string(),
              user: namedSchema.nullable()
            })
            .strict()
        )
      })
      .strict()
      .optional()
  })
  .strict();

const issueConnectionSchema = z
  .object({
    nodes: z.array(issueSchema),
    pageInfo: z
      .object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable()
      })
      .strict()
  })
  .strict();

function stateCategory(type: string): WorkStateCategory {
  if (type === 'started') return 'in_progress';
  if (type === 'completed') return 'done';
  if (type === 'canceled') return 'canceled';
  if (type === 'backlog') return 'backlog';
  return 'todo';
}

function toItem(value: z.infer<typeof issueSchema>): ExternalWorkItemDetail {
  return {
    source: 'linear',
    locator: value.id,
    key: value.identifier,
    title: value.title,
    description: value.description ?? '',
    url: value.url,
    status: value.state.name,
    stateCategory: stateCategory(value.state.type),
    priority: value.priorityLabel || null,
    assignee: value.assignee?.name ?? null,
    project: value.project?.name ?? value.team.name,
    labels: value.labels.nodes.map(label => label.name),
    updatedAt: value.updatedAt,
    comments: (value.comments?.nodes ?? []).map(comment => ({
      author: comment.user?.name ?? 'Unknown',
      body: comment.body,
      createdAt: comment.createdAt
    }))
  };
}

async function requestLinear(
  apiKey: string,
  query: string,
  variables: Record<string, string> = {}
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(LINEAR_API, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Could not reach Linear');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Linear returned HTTP ${response.status}`);
  const envelope = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.unknown()).optional()
    })
    .passthrough()
    .parse(payload);
  if (envelope.errors && envelope.errors.length > 0) {
    throw new Error('Linear rejected the request');
  }
  return envelope.data;
}

export function createLinearAdapter(options: {
  enabled: boolean;
  apiKey: string | undefined;
  teamKey: string;
}): WorkSourceAdapter {
  const teamKey = options.teamKey.trim();
  const apiKey = options.apiKey?.trim() ?? '';
  const hasApiKey = Boolean(apiKey);
  const configured = options.enabled && hasApiKey && Boolean(teamKey);

  async function loadIssue(locator: string): Promise<ExternalWorkItemDetail> {
    const data = await requestLinear(apiKey, issueQuery, { id: locator });
    const issue = z.object({ issue: issueSchema }).strict().parse(data).issue;
    if (issue.id !== locator) {
      throw new Error(`Linear returned the wrong issue for ${locator}`);
    }
    if (issue.team.key.toLowerCase() !== teamKey.toLowerCase()) {
      throw new Error(
        `Linear issue ${locator} is outside the configured scope`
      );
    }
    return toItem(issue);
  }

  async function statusOptions(
    locator: string
  ): Promise<ExternalWorkStatusOption[]> {
    const data = await requestLinear(apiKey, issueStatusOptionsQuery, {
      id: locator
    });
    const result = z
      .object({
        issue: z
          .object({
            id: z.string().min(1),
            state: stateSchema,
            team: z
              .object({
                key: z.string(),
                states: z.object({ nodes: z.array(stateSchema) }).strict()
              })
              .strict()
          })
          .strict()
      })
      .strict()
      .parse(data).issue;
    if (result.id !== locator) {
      throw new Error(`Linear returned the wrong issue for ${locator}`);
    }
    if (result.team.key.toLowerCase() !== teamKey.toLowerCase()) {
      throw new Error(
        `Linear issue ${locator} is outside the configured scope`
      );
    }
    return [
      ...new Map(
        result.team.states.nodes.map(state => [state.id, state])
      ).values()
    ].map(state => ({
      id: state.id,
      name: state.name,
      stateCategory: stateCategory(state.type),
      current: state.id === result.state.id
    }));
  }

  return {
    source: 'linear',
    configured: () => configured,
    configurationMessage: () =>
      !options.enabled
        ? 'Enable Linear for this BB project in Manage.'
        : !teamKey
          ? 'Choose a Linear team key for this BB project in Manage.'
          : hasApiKey
            ? null
            : 'Add a Linear personal API key for this BB project in Manage.',
    async list() {
      if (!configured) throw new Error('Linear is not configured');
      const issues: z.infer<typeof issueSchema>[] = [];
      const seenCursors = new Set<string>();
      let after: string | undefined;
      for (;;) {
        const data = await requestLinear(apiKey, teamIssuesQuery, {
          teamKey,
          ...(after ? { after } : {})
        });
        const connection = z
          .object({ issues: issueConnectionSchema })
          .strict()
          .parse(data).issues;
        if (
          connection.nodes.some(
            issue => issue.team.key.toLowerCase() !== teamKey.toLowerCase()
          )
        ) {
          throw new Error(
            'Linear returned an issue outside the configured team'
          );
        }
        issues.push(...connection.nodes);
        if (!connection.pageInfo.hasNextPage) break;
        const cursor = connection.pageInfo.endCursor;
        if (!cursor || seenCursors.has(cursor)) {
          throw new Error('Linear returned an invalid pagination cursor');
        }
        seenCursors.add(cursor);
        after = cursor;
      }
      return issues.map(issue => withoutComments(toItem(issue)));
    },
    async get(locator) {
      if (!configured) throw new Error('Linear is not configured');
      return loadIssue(locator);
    },
    async statusOptions(locator) {
      if (!configured) throw new Error('Linear is not configured');
      return statusOptions(locator);
    },
    async updateStatus(locator, statusId) {
      if (!configured) throw new Error('Linear is not configured');
      const available = await statusOptions(locator);
      const target = available.find(option => option.id === statusId);
      if (!target) {
        throw new Error('Linear status is not available for this issue');
      }
      if (target.current) return loadIssue(locator);
      const data = await requestLinear(apiKey, updateIssueStatusMutation, {
        id: locator,
        stateId: statusId
      });
      const update = z
        .object({
          issueUpdate: z
            .object({ success: z.boolean(), issue: issueSchema })
            .strict()
        })
        .strict()
        .parse(data).issueUpdate;
      if (!update.success) throw new Error('Linear rejected the status update');
      if (
        update.issue.id !== locator ||
        update.issue.state.id !== statusId ||
        update.issue.team.key.toLowerCase() !== teamKey.toLowerCase()
      ) {
        throw new Error('Linear returned an invalid status update result');
      }
      return toItem(update.issue);
    }
  };
}
