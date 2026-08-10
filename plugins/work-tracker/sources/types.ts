import type {
  WorkItem,
  WorkItemDetail,
  WorkSource,
  WorkStatusOption
} from '../contract.js';

export type ExternalWorkItem = Omit<WorkItem, 'bbProjectId'>;
export type ExternalWorkItemDetail = Omit<WorkItemDetail, 'bbProjectId'>;
export type ExternalWorkStatusOption = WorkStatusOption;

export function withoutComments(
  item: ExternalWorkItemDetail
): ExternalWorkItem {
  const { comments: _comments, ...summary } = item;
  return summary;
}

export interface WorkSourceAdapter {
  readonly source: WorkSource;
  configured(): boolean;
  configurationMessage(): string | null;
  list(options?: { refresh?: boolean }): Promise<ExternalWorkItem[]>;
  get(locator: string): Promise<ExternalWorkItemDetail>;
  statusOptions(locator: string): Promise<ExternalWorkStatusOption[]>;
  updateStatus(
    locator: string,
    statusId: string
  ): Promise<ExternalWorkItemDetail>;
}
