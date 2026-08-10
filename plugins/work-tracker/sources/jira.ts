import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { WorkStateCategory } from '../contract.js';
import type {
  ExternalWorkItemDetail,
  ExternalWorkStatusOption,
  WorkSourceAdapter
} from './types.js';
import { withoutComments } from './types.js';

const jiraIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    fields: z
      .object({
        summary: z.string(),
        description: z.unknown().nullable().optional(),
        updated: z.string(),
        status: z
          .object({
            id: z.string().min(1),
            name: z.string(),
            statusCategory: z.object({ key: z.string() }).passthrough()
          })
          .passthrough(),
        priority: z.object({ name: z.string() }).passthrough().nullable(),
        assignee: z
          .object({ displayName: z.string() })
          .passthrough()
          .nullable(),
        project: z.object({ key: z.string(), name: z.string() }).passthrough(),
        labels: z.array(z.string()),
        comment: z
          .object({
            comments: z.array(
              z
                .object({
                  body: z.unknown(),
                  created: z.string(),
                  author: z.object({ displayName: z.string() }).passthrough()
                })
                .passthrough()
            )
          })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough();

const jiraSearchPageSchema = z
  .object({
    issues: z.array(jiraIssueSchema),
    nextPageToken: z.string().nullable().optional()
  })
  .passthrough();

const jiraJqlMatchSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            matchedIssues: z.array(z.number().int().positive()),
            errors: z.array(z.string())
          })
          .passthrough()
      )
      .length(1)
  })
  .passthrough();

const jiraTransitionsSchema = z
  .object({
    transitions: z.array(
      z
        .object({
          id: z.string().min(1),
          to: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              statusCategory: z.object({ key: z.string() }).passthrough()
            })
            .passthrough()
        })
        .passthrough()
    )
  })
  .passthrough();

function adfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const own = typeof record.text === 'string' ? record.text : '';
  const children = Array.isArray(record.content)
    ? record.content.map(adfText).filter(Boolean)
    : [];
  const joined = [own, ...children]
    .filter(Boolean)
    .join(record.type === 'paragraph' || record.type === 'heading' ? '' : '\n');
  return record.type === 'paragraph' || record.type === 'heading'
    ? `${joined}\n`
    : joined;
}

function stateCategory(key: string): WorkStateCategory {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in_progress';
  return 'todo';
}

function toItem(
  baseUrl: string,
  issue: z.infer<typeof jiraIssueSchema>
): ExternalWorkItemDetail {
  return {
    source: 'jira',
    locator: issue.key,
    key: issue.key,
    title: issue.fields.summary,
    description: adfText(issue.fields.description).trim(),
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    status: issue.fields.status.name,
    stateCategory: stateCategory(issue.fields.status.statusCategory.key),
    priority: issue.fields.priority?.name ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
    project: issue.fields.project.name,
    labels: issue.fields.labels,
    updatedAt: issue.fields.updated,
    comments: (issue.fields.comment?.comments ?? []).map(comment => ({
      author: comment.author.displayName,
      body: adfText(comment.body).trim(),
      createdAt: comment.created
    }))
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const hasExplicitPort = /^https:\/\/[^/?#]+:\d+(?:[/?#]|$)/iu.test(trimmed);
    if (
      parsed.protocol !== 'https:' ||
      !(
        parsed.hostname === 'atlassian.net' ||
        parsed.hostname.endsWith('.atlassian.net')
      ) ||
      parsed.username ||
      parsed.password ||
      hasExplicitPort ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

async function jiraRequest(
  options: { baseUrl: string; email: string; apiToken: string },
  path: string,
  init?: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`,
        ...(init?.body === undefined
          ? {}
          : { 'content-type': 'application/json' })
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Could not reach Jira');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Jira returned HTTP ${response.status}`);
  return payload;
}

export function createJiraAdapter(options: {
  enabled: boolean;
  baseUrl: string;
  email: string;
  apiToken: string | undefined;
  jql: string;
}): WorkSourceAdapter {
  const rawBaseUrl = options.baseUrl.trim();
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const email = options.email.trim();
  const apiToken = options.apiToken?.trim() ?? '';
  const hasCredentials = Boolean(baseUrl && email && apiToken);
  const configured = options.enabled && hasCredentials;
  const auth = {
    baseUrl,
    email,
    apiToken
  };

  async function loadIssue(
    locator: string,
    flags: { comments: boolean; verifyScope: boolean }
  ): Promise<z.infer<typeof jiraIssueSchema>> {
    const fields = [
      'summary',
      'description',
      'updated',
      'status',
      'priority',
      'assignee',
      'project',
      'labels',
      ...(flags.comments ? ['comment'] : [])
    ].join(',');
    const payload = await jiraRequest(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(locator)}?fields=${encodeURIComponent(fields)}`
    );
    const issue = jiraIssueSchema.parse(payload);
    if (issue.key !== locator) {
      throw new Error(`Jira returned the wrong issue for ${locator}`);
    }
    if (!flags.verifyScope) return issue;
    const issueId = Number(issue.id);
    if (!Number.isSafeInteger(issueId)) {
      throw new Error(`Jira returned an invalid issue id for ${locator}`);
    }
    const matchPayload = await jiraRequest(auth, '/rest/api/3/jql/match', {
      method: 'POST',
      body: JSON.stringify({
        issueIds: [issueId],
        jqls: [options.jql.trim()]
      })
    });
    const match = jiraJqlMatchSchema.parse(matchPayload).matches[0];
    if (!match || match.errors.length > 0) {
      throw new Error('Jira could not verify the configured scope');
    }
    if (!match.matchedIssues.includes(issueId)) {
      throw new Error(`Jira issue ${locator} is outside the configured scope`);
    }
    return issue;
  }

  async function transitionOptions(locator: string): Promise<{
    issue: z.infer<typeof jiraIssueSchema>;
    options: Array<ExternalWorkStatusOption & { transitionId: string | null }>;
  }> {
    const issue = await loadIssue(locator, {
      comments: false,
      verifyScope: true
    });
    const payload = await jiraRequest(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(locator)}/transitions`
    );
    const transitions = jiraTransitionsSchema.parse(payload).transitions;
    const available = new Map<
      string,
      ExternalWorkStatusOption & { transitionId: string | null }
    >();
    available.set(issue.fields.status.id, {
      id: issue.fields.status.id,
      name: issue.fields.status.name,
      stateCategory: stateCategory(issue.fields.status.statusCategory.key),
      current: true,
      transitionId: null
    });
    for (const transition of transitions) {
      if (available.has(transition.to.id)) continue;
      available.set(transition.to.id, {
        id: transition.to.id,
        name: transition.to.name,
        stateCategory: stateCategory(transition.to.statusCategory.key),
        current: transition.to.id === issue.fields.status.id,
        transitionId: transition.id
      });
    }
    return { issue, options: [...available.values()] };
  }

  return {
    source: 'jira',
    configured: () => configured,
    configurationMessage: () =>
      !options.enabled
        ? 'Enable Jira for this BB project in Manage.'
        : rawBaseUrl && !baseUrl
          ? 'Jira Cloud URL must be an HTTPS atlassian.net origin.'
          : hasCredentials
            ? null
            : 'Set the Jira URL, email, and API token for this BB project in Manage.',
    async list() {
      if (!configured) throw new Error('Jira is not configured');
      const issues: z.infer<typeof jiraIssueSchema>[] = [];
      const seenPageTokens = new Set<string>();
      let nextPageToken: string | undefined;
      for (;;) {
        const payload = await jiraRequest(auth, '/rest/api/3/search/jql', {
          method: 'POST',
          body: JSON.stringify({
            jql: options.jql.trim(),
            maxResults: 100,
            fields: [
              'summary',
              'description',
              'updated',
              'status',
              'priority',
              'assignee',
              'project',
              'labels'
            ],
            ...(nextPageToken ? { nextPageToken } : {})
          })
        });
        const page = jiraSearchPageSchema.parse(payload);
        issues.push(...page.issues);
        const token = page.nextPageToken?.trim();
        if (!token) break;
        if (seenPageTokens.has(token)) {
          throw new Error('Jira returned an invalid pagination token');
        }
        seenPageTokens.add(token);
        nextPageToken = token;
      }
      return issues.map(issue => withoutComments(toItem(baseUrl, issue)));
    },
    async get(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const issue = await loadIssue(locator, {
        comments: true,
        verifyScope: true
      });
      return toItem(baseUrl, issue);
    },
    async statusOptions(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const result = await transitionOptions(locator);
      return result.options.map(
        ({ transitionId: _transitionId, ...option }) => option
      );
    },
    async updateStatus(locator, statusId) {
      if (!configured) throw new Error('Jira is not configured');
      const available = await transitionOptions(locator);
      const target = available.options.find(option => option.id === statusId);
      if (!target) {
        throw new Error('Jira status is not available for this issue');
      }
      if (!target.current) {
        if (!target.transitionId) {
          throw new Error('Jira status does not have an available transition');
        }
        await jiraRequest(
          auth,
          `/rest/api/3/issue/${encodeURIComponent(locator)}/transitions`,
          {
            method: 'POST',
            body: JSON.stringify({ transition: { id: target.transitionId } })
          }
        );
      }
      const issue = await loadIssue(locator, {
        comments: false,
        verifyScope: false
      });
      if (issue.fields.status.id !== statusId) {
        throw new Error('Jira returned an invalid status update result');
      }
      return toItem(baseUrl, issue);
    }
  };
}
