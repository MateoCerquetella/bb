import { defineRpcContract } from '@bb/plugin-sdk';
import { z } from 'zod';

export const workSourceSchema = z.enum(['linear', 'github', 'jira']);
export type WorkSource = z.infer<typeof workSourceSchema>;

export const bbProjectIdSchema = z.string().startsWith('proj_');

export const jiraBaseUrlSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    if (!value) return '';
    try {
      const url = new URL(value);
      const hasExplicitPort = /^https:\/\/[^/?#]+:\d+(?:[/?#]|$)/iu.test(value);
      const isAtlassian =
        url.hostname === 'atlassian.net' ||
        url.hostname.endsWith('.atlassian.net');
      if (
        url.protocol !== 'https:' ||
        !isAtlassian ||
        url.username ||
        url.password ||
        hasExplicitPort ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Jira URL must be an HTTPS atlassian.net origin'
        });
        return z.NEVER;
      }
      return url.origin;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Jira URL must be an HTTPS atlassian.net origin'
      });
      return z.NEVER;
    }
  });

export const trackerProjectSchema = z
  .object({
    id: bbProjectIdSchema,
    name: z.string()
  })
  .strict();
export type TrackerProject = z.infer<typeof trackerProjectSchema>;

export const projectSourceConfigSchema = z
  .object({
    projectId: bbProjectIdSchema,
    githubEnabled: z.boolean(),
    linearEnabled: z.boolean(),
    linearTeamKey: z.string().trim(),
    jiraEnabled: z.boolean(),
    jiraBaseUrl: jiraBaseUrlSchema,
    jiraEmail: z.string().trim(),
    jiraJql: z.string().trim().min(1)
  })
  .strict();
export type ProjectSourceConfig = z.infer<typeof projectSourceConfigSchema>;

export const secretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
  z
    .object({
      operation: z.literal('set'),
      value: z
        .string()
        .trim()
        .min(1)
        .max(16_384)
        .refine(value => !/[\r\n]/u.test(value), {
          message: 'Credential must be a single line'
        })
    })
    .strict()
]);
export type SecretMutation = z.infer<typeof secretMutationSchema>;

export const projectConfigViewSchema = projectSourceConfigSchema
  .extend({
    githubRepos: z.array(z.string()),
    linearCredentialConfigured: z.boolean(),
    jiraCredentialConfigured: z.boolean()
  })
  .strict();
export type ProjectConfigView = z.infer<typeof projectConfigViewSchema>;

export const projectConfigMutationSchema = projectSourceConfigSchema
  .extend({
    linearCredential: secretMutationSchema,
    jiraCredential: secretMutationSchema
  })
  .strict()
  .superRefine((config, context) => {
    if (config.linearEnabled && !config.linearTeamKey) {
      context.addIssue({
        code: 'custom',
        path: ['linearTeamKey'],
        message: 'Linear team key is required when Linear is enabled'
      });
    }
  });
export type ProjectConfigMutation = z.infer<typeof projectConfigMutationSchema>;

export const projectCredentialsInteractionPayloadSchema = z
  .object({
    projectId: bbProjectIdSchema,
    projectName: z.string(),
    linearTeamKey: z.string(),
    jiraBaseUrl: jiraBaseUrlSchema,
    jiraEmail: z.string(),
    linearCredentialConfigured: z.boolean(),
    jiraCredentialConfigured: z.boolean()
  })
  .strict();
export type ProjectCredentialsInteractionPayload = z.infer<
  typeof projectCredentialsInteractionPayloadSchema
>;

export const projectCredentialsInteractionResponseSchema = z
  .object({
    linearCredential: secretMutationSchema,
    jiraCredential: secretMutationSchema
  })
  .strict();
export type ProjectCredentialsInteractionResponse = z.infer<
  typeof projectCredentialsInteractionResponseSchema
>;

export const workStateCategorySchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'done',
  'canceled'
]);
export type WorkStateCategory = z.infer<typeof workStateCategorySchema>;

export const workStatusOptionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    stateCategory: workStateCategorySchema,
    current: z.boolean()
  })
  .strict();
export type WorkStatusOption = z.infer<typeof workStatusOptionSchema>;

export const workItemSchema = z
  .object({
    bbProjectId: bbProjectIdSchema,
    source: workSourceSchema,
    locator: z.string().min(1),
    key: z.string().min(1),
    title: z.string(),
    description: z.string(),
    url: z.string(),
    status: z.string(),
    stateCategory: workStateCategorySchema,
    priority: z.string().nullable(),
    assignee: z.string().nullable(),
    project: z.string().nullable(),
    labels: z.array(z.string()),
    updatedAt: z.string()
  })
  .strict();
export type WorkItem = z.infer<typeof workItemSchema>;

export const workCommentSchema = z
  .object({
    author: z.string(),
    body: z.string(),
    createdAt: z.string()
  })
  .strict();

export const workItemDetailSchema = workItemSchema
  .extend({ comments: z.array(workCommentSchema) })
  .strict();
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>;

export const workSourceStatusSchema = z
  .object({
    source: workSourceSchema,
    configured: z.boolean(),
    available: z.boolean(),
    message: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
    itemCount: z.number().int().nonnegative()
  })
  .strict();
export type WorkSourceStatus = z.infer<typeof workSourceStatusSchema>;

const listInputSchema = z
  .object({
    projectId: bbProjectIdSchema.optional(),
    source: workSourceSchema.optional(),
    query: z.string().optional(),
    stateCategories: z.array(workStateCategorySchema).optional(),
    limit: z.number().int().min(1).max(500).default(200)
  })
  .strict();

export const workTrackerRpcContract = defineRpcContract({
  listProjects: {
    input: z.null(),
    output: z.object({ projects: z.array(trackerProjectSchema) }).strict()
  },
  status: {
    input: z.object({ projectId: bbProjectIdSchema }).strict(),
    output: z.object({ sources: z.array(workSourceStatusSchema) }).strict()
  },
  listItems: {
    input: listInputSchema,
    output: z.object({ items: z.array(workItemSchema) }).strict()
  },
  refresh: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        source: workSourceSchema.optional()
      })
      .strict(),
    output: z
      .object({
        sources: z.array(workSourceStatusSchema),
        itemCount: z.number().int().nonnegative()
      })
      .strict()
  },
  getItem: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        source: workSourceSchema,
        locator: z.string().min(1)
      })
      .strict(),
    output: z.object({ item: workItemDetailSchema }).strict()
  },
  statusOptions: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        source: workSourceSchema,
        locator: z.string().min(1)
      })
      .strict(),
    output: z.object({ options: z.array(workStatusOptionSchema) }).strict()
  },
  updateItemStatus: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        source: workSourceSchema,
        locator: z.string().min(1),
        statusId: z.string().min(1)
      })
      .strict(),
    output: z.object({ item: workItemSchema }).strict()
  },
  getProjectConfig: {
    input: z.object({ projectId: bbProjectIdSchema }).strict(),
    output: z.object({ config: projectConfigViewSchema }).strict()
  },
  saveProjectConfig: {
    input: projectConfigMutationSchema,
    output: z.object({ config: projectConfigViewSchema }).strict()
  }
});

export type WorkTrackerRpcContract = typeof workTrackerRpcContract;

export function formatWorkItemContext(item: WorkItemDetail | WorkItem): string {
  const lines = [
    `# ${sourceName(item.source)} issue ${item.key}: ${item.title}`,
    '',
    `- Status: ${item.status}`,
    `- Priority: ${item.priority ?? 'None'}`,
    `- Assignee: ${item.assignee ?? 'Unassigned'}`,
    `- BB project: ${item.bbProjectId}`,
    `- Project: ${item.project ?? 'None'}`,
    `- Labels: ${item.labels.join(', ') || 'None'}`,
    `- URL: ${item.url}`,
    '',
    '## Description',
    '',
    item.description.trim() || 'No description provided.'
  ];
  return lines.join('\n');
}

export function sourceName(source: WorkSource): string {
  if (source === 'github') return 'GitHub';
  if (source === 'jira') return 'Jira';
  return 'Linear';
}
