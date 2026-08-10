import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import {
  Markdown,
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
  type PluginPendingInteractionProps
} from '@bb/plugin-sdk/app';
import { Badge } from '@bb/shared-ui/badge';
import { Button } from '@bb/shared-ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@bb/shared-ui/dropdown-menu';
import { Icon, type IconName } from '@bb/shared-ui/icon';
import { Input } from '@bb/shared-ui/input';
import { cn } from '@bb/shared-ui/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@bb/shared-ui/select';
import { Skeleton } from '@bb/shared-ui/skeleton';
import { Switch } from '@bb/shared-ui/switch';
import { Textarea } from '@bb/shared-ui/textarea';
import type {
  ProjectConfigMutation,
  ProjectConfigView,
  ProjectCredentialsInteractionResponse,
  SecretMutation,
  TrackerProject,
  WorkItem,
  WorkItemDetail,
  WorkSource,
  WorkStateCategory,
  WorkStatusOption,
  WorkTrackerRpcContract
} from './contract.js';
import {
  jiraBaseUrlSchema,
  projectCredentialsInteractionPayloadSchema,
  projectCredentialsInteractionResponseSchema
} from './contract.js';
import './app.css';

const PANEL_PATH = 'tracker';
const ALL_SOURCES = 'all';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'bb-work-tracker:sidebar-collapsed';
const SIDEBAR_WIDTH_STORAGE_KEY = 'bb-work-tracker:sidebar-width';
const LAST_PROJECT_STORAGE_KEY = 'bb-work-tracker:last-project';
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 720;
const SIDEBAR_DEFAULT_WIDTH = 208;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 340;

const STATE_CATEGORY_ORDER: readonly WorkStateCategory[] = [
  'backlog',
  'todo',
  'in_progress',
  'done',
  'canceled'
];

const STATE_CATEGORY_LABELS: Readonly<Record<WorkStateCategory, string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  done: 'Done',
  canceled: 'Canceled'
};

type SourceFilter = typeof ALL_SOURCES | WorkSource;
type TrackerView = 'list' | 'kanban';

interface TrackerBrowsePreferences {
  source: SourceFilter;
  stateCategories: WorkStateCategory[];
  query: string;
  committedQuery: string;
  view: TrackerView;
}

type TrackerRoute =
  | { kind: 'root' }
  | { kind: 'all' }
  | { kind: 'project'; projectId: string }
  | { kind: 'manage'; projectId: string | null }
  | {
      kind: 'item';
      projectId: string;
      source: WorkSource;
      locator: string;
    };

function loadLastProjectId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}

function ManageHeaderAction({ subPath }: PluginNavPanelProps) {
  const route = parseTrackerRoute(subPath);
  const { projectId: contextProjectId } = useBbContext();
  const navigate = useBbNavigate();
  const routeProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : null;
  const projectId = routeProjectId ?? contextProjectId ?? loadLastProjectId();

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() =>
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: projectId
            ? routeToSubPath({ kind: 'manage', projectId })
            : 'manage'
        })
      }
    >
      <Icon name="Settings" className="size-4" />
      Manage
    </Button>
  );
}

function encodeLocator(locator: string): string {
  // encodeURIComponent deliberately leaves "~" untouched, but this route uses
  // it as the percent-escape marker. Escape literal tildes first so arbitrary
  // external locators still round-trip without colliding with that marker.
  return encodeURIComponent(locator)
    .replaceAll('~', '%7E')
    .replaceAll('%', '~');
}

function decodeLocator(locator: string): string {
  try {
    return decodeURIComponent(locator.replaceAll('~', '%'));
  } catch {
    return '';
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isWorkSource(value: string): value is WorkSource {
  return value === 'linear' || value === 'github' || value === 'jira';
}

function sourceName(source: WorkSource): string {
  if (source === 'github') return 'GitHub';
  if (source === 'jira') return 'Jira';
  return 'Linear';
}

function parseTrackerRoute(rawSubPath: string): TrackerRoute {
  const path = rawSubPath.split('?', 1)[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const head = segments[0];
  if (head === undefined) return { kind: 'root' };
  if (head === 'all') return { kind: 'all' };
  if (head === 'manage') {
    return {
      kind: 'manage',
      projectId: segments[1] ? decodeSegment(segments[1]) : null
    };
  }
  if (head === 'item') {
    const projectId = segments[1];
    const source = segments[2];
    const encodedLocator = segments[3];
    if (projectId && source && isWorkSource(source) && encodedLocator) {
      const locator = decodeLocator(encodedLocator);
      if (locator) {
        return {
          kind: 'item',
          projectId: decodeSegment(projectId),
          source,
          locator
        };
      }
    }
    return { kind: 'all' };
  }
  return { kind: 'project', projectId: decodeSegment(head) };
}

function routeToSubPath(route: TrackerRoute): string {
  switch (route.kind) {
    case 'root':
      return '';
    case 'all':
      return 'all';
    case 'manage':
      return route.projectId
        ? `manage/${encodeURIComponent(route.projectId)}`
        : 'manage';
    case 'project':
      return encodeURIComponent(route.projectId);
    case 'item':
      return `item/${encodeURIComponent(route.projectId)}/${route.source}/${encodeLocator(route.locator)}`;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changedProjectId(payload: unknown): string | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('projectId' in payload) ||
    typeof payload.projectId !== 'string'
  ) {
    return null;
  }
  return payload.projectId;
}

function useRefreshOnReconnect(refresh: () => void): void {
  const connectionState = useRealtimeConnectionState();
  const previousStateRef = useRef(connectionState);
  // "reconnecting" proves this shared socket connected before this component
  // mounted; only "connecting" is the initial, never-connected state.
  const hasConnectedRef = useRef(connectionState !== 'connecting');
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (
      connectionState === 'connected' &&
      hasConnectedRef.current &&
      previousStateRef.current !== 'connected'
    ) {
      refreshRef.current();
    }
    if (connectionState === 'connected') hasConnectedRef.current = true;
    previousStateRef.current = connectionState;
  }, [connectionState]);
}

function loadSidebarCollapsed(): boolean {
  try {
    return (
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
    );
  } catch {
    return false;
  }
}

function storeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      String(collapsed)
    );
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function loadSidebarWidth(): number {
  try {
    const stored = Number(
      window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    );
    return Number.isFinite(stored) && stored > 0
      ? clampSidebarWidth(stored)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function storeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(new Date(timestamp));
}

function statusTone(category: WorkStateCategory) {
  if (category === 'done') return 'secondary' as const;
  if (category === 'in_progress') return 'default' as const;
  return 'outline' as const;
}

function StateDot({ category }: { category: WorkStateCategory }) {
  return (
    <span
      aria-hidden
      data-state-category={category}
      className="wt-state-dot size-3 shrink-0 rounded-full border-2"
    />
  );
}

function SidebarRow({
  active = false,
  onClick,
  children
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      data-active={active ? 'true' : 'false'}
      className={cn(
        'wt-sidebar-row flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:pointer-coarse:h-10',
        active ? 'font-medium text-foreground' : 'hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function TrackerSidebar({
  route,
  projects,
  isLoading,
  preferredProjectId,
  overlay = false,
  onNavigate
}: {
  route: TrackerRoute;
  projects: readonly TrackerProject[] | undefined;
  isLoading: boolean;
  preferredProjectId: string | null;
  overlay?: boolean;
  onNavigate: (route: TrackerRoute) => void;
}) {
  const activeProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'root'
        ? preferredProjectId
        : null;
  const managedProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : preferredProjectId;
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    const rightEdge = asideRef.current?.getBoundingClientRect().right;
    if (rightEdge === undefined) return;
    setWidth(clampSidebarWidth(Math.round(rightEdge - event.clientX)));
  };
  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    storeSidebarWidth(widthRef.current);
  };
  const resetWidth = () => {
    setWidth(SIDEBAR_DEFAULT_WIDTH);
    storeSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  };
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') nextWidth = widthRef.current + 10;
    if (event.key === 'ArrowRight') nextWidth = widthRef.current - 10;
    if (event.key === 'Home') nextWidth = SIDEBAR_MIN_WIDTH;
    if (event.key === 'End') nextWidth = SIDEBAR_MAX_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(nextWidth);
    setWidth(clamped);
    storeSidebarWidth(clamped);
  };

  return (
    <aside
      ref={asideRef}
      aria-label="Work Tracker navigation"
      style={overlay ? undefined : { width }}
      className={cn(
        'wt-sidebar relative flex h-full shrink-0 flex-col border-l',
        overlay && 'w-72 min-w-0 max-w-full shadow-lg',
        resizing && 'select-none'
      )}
    >
      {!overlay ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          className={cn(
            'absolute inset-y-0 -left-px z-10 w-1 cursor-col-resize transition-colors focus-visible:bg-primary/50 focus-visible:outline-none',
            resizing ? 'bg-primary/50' : 'hover:bg-primary/30'
          )}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={resetWidth}
          onKeyDown={resizeWithKeyboard}
        />
      ) : null}
      <nav
        aria-label="Work Tracker navigation"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-3"
      >
        <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">
          Projects
        </div>
        {isLoading ? (
          <div className="space-y-2 px-2 pt-2">
            {['w-3/4', 'w-2/3', 'w-4/5'].map(width => (
              <div className="flex h-7 items-center gap-2" key={width}>
                <Skeleton className="size-3 rounded-sm" />
                <Skeleton className={cn('h-3', width)} />
              </div>
            ))}
          </div>
        ) : projects && projects.length > 0 ? (
          <div className="space-y-px">
            {projects.map(project => (
              <SidebarRow
                key={project.id}
                active={activeProjectId === project.id}
                onClick={() =>
                  onNavigate({ kind: 'project', projectId: project.id })
                }
              >
                <Icon name="Folder" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={project.name}>
                  {project.name}
                </span>
              </SidebarRow>
            ))}
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No BB projects found.
          </p>
        )}

        <div className="my-3 border-t border-border-hairline/80" />
        <div className="space-y-px">
          <SidebarRow
            active={route.kind === 'all'}
            onClick={() => onNavigate({ kind: 'all' })}
          >
            <Icon name="ListView" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Across projects</span>
          </SidebarRow>
        </div>
      </nav>

      <div className="shrink-0 border-t border-border-hairline px-2 py-1.5">
        <SidebarRow
          active={route.kind === 'manage'}
          onClick={() =>
            onNavigate({ kind: 'manage', projectId: managedProjectId })
          }
        >
          <Icon name="Settings" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Manage</span>
        </SidebarRow>
      </div>
    </aside>
  );
}

function SidebarDrawer({
  onClose,
  children
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Work Tracker sidebar"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-30 focus-visible:outline-none"
    >
      <button
        type="button"
        aria-label="Close sidebar"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/18 backdrop-blur-[2px]"
      />
      <div className="absolute inset-y-0 right-0 flex max-w-[85%]">
        {children}
      </div>
    </div>
  );
}

function TrackerTopbar({
  route,
  projects,
  sidebarCollapsed,
  refreshing,
  refreshDisabled,
  onNavigate,
  onBack,
  onRefresh,
  onToggleSidebar
}: {
  route: TrackerRoute;
  projects: readonly TrackerProject[] | undefined;
  sidebarCollapsed: boolean;
  refreshing: boolean;
  refreshDisabled: boolean;
  onNavigate: (route: TrackerRoute) => void;
  onBack: () => void;
  onRefresh: () => void;
  onToggleSidebar: () => void;
}) {
  const projectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : null;
  const project = projects?.find(candidate => candidate.id === projectId);

  const breadcrumb = (() => {
    if (route.kind === 'root') {
      return (
        <span className="whitespace-nowrap font-semibold">Work Tracker</span>
      );
    }
    if (route.kind === 'all') {
      return (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="font-semibold">Across projects</span>
          <span className="wt-topbar-pill rounded-full px-2 py-0.5 text-[11px] font-medium">
            All
          </span>
        </span>
      );
    }
    if (route.kind === 'manage') {
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className="whitespace-nowrap font-semibold">
            Project settings
          </span>
          {project ? (
            <>
              <Icon
                name="ChevronRight"
                className="size-3 shrink-0 text-muted-foreground"
              />
              <span className="truncate text-xs font-normal text-muted-foreground">
                {project.name}
              </span>
            </>
          ) : null}
        </span>
      );
    }
    if (route.kind === 'project') {
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            name="Folder"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate font-semibold">
            {project?.name ?? 'BB project'}
          </span>
          <span className="wt-topbar-pill hidden rounded-full px-2 py-0.5 text-[11px] font-medium @md:inline-flex">
            Issues
          </span>
        </span>
      );
    }
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 max-md:pointer-coarse:size-9"
          aria-label="Back to work items"
          onClick={onBack}
        >
          <Icon name="ChevronLeft" className="size-4" />
        </Button>
        <button
          type="button"
          className="hidden min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground @md:flex"
          onClick={() =>
            onNavigate({ kind: 'project', projectId: route.projectId })
          }
        >
          <Icon name="Folder" className="size-3.5 shrink-0" />
          <span className="truncate font-medium">
            {project?.name ?? 'BB project'}
          </span>
        </button>
        <Icon
          name="ChevronRight"
          className="hidden size-3 shrink-0 text-muted-foreground @md:block"
        />
        <span className="min-w-0 truncate font-medium text-muted-foreground">
          {route.locator}
        </span>
      </span>
    );
  })();

  return (
    <header className="wt-topbar flex h-11 shrink-0 items-center gap-2.5 border-b px-3.5 text-sm max-md:h-12 max-md:pl-12 max-md:pointer-coarse:pl-14">
      <div className="min-w-0 flex-1 overflow-hidden">{breadcrumb}</div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground max-md:pointer-coarse:size-9"
        aria-label="Refresh work items"
        aria-busy={refreshing}
        disabled={refreshDisabled || refreshing}
        onClick={onRefresh}
      >
        <Icon
          name="RotateCcw"
          className={cn('size-3.5', refreshing && 'animate-spin')}
        />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 max-md:pointer-coarse:size-9"
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <Icon name="PanelRight" className="size-4" />
      </Button>
    </header>
  );
}

function toggled<T>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter(candidate => candidate !== value);
}

function FilterChip({
  icon,
  label,
  selectedNames,
  children
}: {
  icon: IconName;
  label: string;
  selectedNames: readonly string[];
  children: ReactNode;
}) {
  const active = selectedNames.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-active={active ? 'true' : 'false'}
          className={cn(
            'wt-filter-chip flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors max-md:pointer-coarse:h-10',
            active ? 'text-foreground' : 'hover:text-foreground'
          )}
        >
          <Icon name={icon} className="size-3" />
          {label}
          {active ? (
            <span className="max-w-40 truncate font-medium @max-md:max-w-24">
              {selectedNames.join(', ')}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrackerFilterBar({
  source,
  stateCategories,
  query,
  view,
  showViewToggle,
  onSourceChange,
  onStateCategoriesChange,
  onQueryChange,
  onViewChange,
  onClear
}: {
  source: SourceFilter;
  stateCategories: readonly WorkStateCategory[];
  query: string;
  view: TrackerView;
  showViewToggle: boolean;
  onSourceChange: (source: SourceFilter) => void;
  onStateCategoriesChange: (categories: WorkStateCategory[]) => void;
  onQueryChange: (query: string) => void;
  onViewChange: (view: TrackerView) => void;
  onClear: () => void;
}) {
  const filtered =
    source !== ALL_SOURCES || stateCategories.length > 0 || query.trim() !== '';
  const keepOpen = (event: Event) => event.preventDefault();

  return (
    <div
      role="search"
      aria-label="Filter work items"
      className="wt-filter-bar flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-px">
        <FilterChip
          icon="GitBranch"
          label="Source"
          selectedNames={source === ALL_SOURCES ? [] : [sourceName(source)]}
        >
          {([ALL_SOURCES, 'linear', 'github', 'jira'] as const).map(option => (
            <DropdownMenuCheckboxItem
              key={option}
              checked={source === option}
              onCheckedChange={checked => {
                if (checked === true) onSourceChange(option);
              }}
            >
              {option === ALL_SOURCES ? 'All sources' : sourceName(option)}
            </DropdownMenuCheckboxItem>
          ))}
        </FilterChip>

        <FilterChip
          icon="Circle"
          label="State"
          selectedNames={stateCategories.map(
            category => STATE_CATEGORY_LABELS[category]
          )}
        >
          {STATE_CATEGORY_ORDER.map(category => (
            <DropdownMenuCheckboxItem
              key={category}
              checked={stateCategories.includes(category)}
              onSelect={keepOpen}
              onCheckedChange={checked =>
                onStateCategoriesChange(
                  toggled(stateCategories, category, checked === true)
                )
              }
            >
              <span className="flex items-center gap-2">
                <StateDot category={category} />
                {STATE_CATEGORY_LABELS[category]}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </FilterChip>

        <div className="wt-search-shell relative min-w-40 flex-1 rounded-md @md:max-w-72">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            aria-label="Search work items"
            placeholder="Search key or title"
            className="wt-search-input h-7 w-full pl-7 text-xs max-md:pointer-coarse:h-10"
          />
        </div>
        {filtered ? (
          <button
            type="button"
            onClick={onClear}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:pointer-coarse:h-10"
          >
            <Icon name="X" className="size-3" />
            Clear filters
          </button>
        ) : null}
      </div>
      {showViewToggle ? (
        <div
          role="group"
          aria-label="Work view"
          className="wt-view-toggle flex shrink-0 rounded-md p-0.5"
        >
          {(['list', 'kanban'] as const).map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              data-active={view === option ? 'true' : 'false'}
              onClick={() => onViewChange(option)}
              className={cn(
                'wt-view-toggle-option flex h-6 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:pointer-coarse:h-9',
                view === option
                  ? 'text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon
                name={option === 'list' ? 'ListView' : 'Columns2'}
                className="size-3.5"
              />
              {option === 'list' ? 'List' : 'Kanban'}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  filtered,
  onClear
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <div className="wt-empty-state flex h-full flex-col items-center justify-center gap-3 rounded-lg p-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon name={filtered ? 'Search' : 'ListTodo'} className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {filtered ? 'No work matches these filters' : 'No work items yet'}
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {filtered
            ? 'Try a different source, state, or search query.'
            : 'Use Manage to choose which external work belongs to this BB project, then refresh.'}
        </p>
      </div>
      {filtered ? (
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="px-3.5 pt-3">
      <Skeleton className="mb-3 h-4 w-28" />
      {Array.from({ length: 7 }, (_, index) => (
        <div
          key={index}
          className="flex h-[34px] items-center gap-2 border-b border-border-hairline"
        >
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}

function WorkItemRow({
  item,
  project,
  showProject,
  onOpen
}: {
  item: WorkItem;
  project: TrackerProject | undefined;
  showProject: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Open ${item.key}: ${item.title}. Source ${sourceName(item.source)}. Priority ${item.priority ?? 'none'}. Assignee ${item.assignee ?? 'unassigned'}.`}
      data-state-category={item.stateCategory}
      onClick={onOpen}
      className="wt-item-row group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-border-hairline px-2.5 py-1.5 text-left transition-colors focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="row-span-2 mt-1 flex" title={item.status}>
        <StateDot category={item.stateCategory} />
      </span>
      <span className="flex min-w-0 items-baseline gap-2.5">
        <span className="wt-key w-24 shrink-0 truncate text-xs font-medium tabular-nums">
          {item.key}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {item.title}
        </span>
      </span>
      <span className="wt-meta col-start-2 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px]">
        <span
          data-source={item.source}
          className="wt-source-chip shrink-0 rounded px-1.5 py-px"
        >
          {sourceName(item.source)}
        </span>
        {showProject && project ? (
          <span className="max-w-28 truncate" title={project.name}>
            {project.name}
          </span>
        ) : null}
        {item.priority ? (
          <span className="shrink-0">{item.priority}</span>
        ) : null}
        {item.assignee ? (
          <span className="hidden max-w-28 truncate @md:inline">
            {item.assignee}
          </span>
        ) : null}
        <time className="ml-auto shrink-0 tabular-nums">
          {formatUpdatedAt(item.updatedAt)}
        </time>
      </span>
    </button>
  );
}

function stateGroups(items: readonly WorkItem[]) {
  return STATE_CATEGORY_ORDER.map(category => ({
    category,
    items: items.filter(item => item.stateCategory === category)
  })).filter(group => group.items.length > 0);
}

function ListStateGroups({
  items,
  projectsById,
  showProject,
  idPrefix,
  nested = false,
  onOpen
}: {
  items: readonly WorkItem[];
  projectsById: ReadonlyMap<string, TrackerProject>;
  showProject: boolean;
  idPrefix: string;
  nested?: boolean;
  onOpen: (item: WorkItem) => void;
}) {
  return stateGroups(items).map(group => (
    <section
      key={group.category}
      aria-labelledby={`${idPrefix}-state-${group.category}`}
    >
      <h3
        id={`${idPrefix}-state-${group.category}`}
        data-state-group-header={group.category}
        data-state-category={group.category}
        className={cn(
          'wt-group-heading sticky z-10 flex h-7 items-center gap-2 border-b px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] backdrop-blur-sm',
          nested ? 'top-9' : 'top-0'
        )}
      >
        <StateDot category={group.category} />
        {STATE_CATEGORY_LABELS[group.category]}
        <span className="text-xs font-normal tabular-nums text-subtle-foreground">
          {group.items.length}
        </span>
      </h3>
      {group.items.map(item => (
        <WorkItemRow
          key={`${item.bbProjectId}:${item.source}:${item.locator}`}
          item={item}
          project={projectsById.get(item.bbProjectId)}
          showProject={showProject}
          onOpen={() => onOpen(item)}
        />
      ))}
    </section>
  ));
}

interface KanbanLane {
  key: string;
  name: string;
  category: WorkStateCategory;
}

function kanbanLaneKey(name: string, category: WorkStateCategory): string {
  return `${category}:${name.trim().toLocaleLowerCase()}`;
}

function kanbanLanes(
  items: readonly WorkItem[],
  discovered: readonly WorkStatusOption[]
): KanbanLane[] {
  const visible = new Map<string, KanbanLane>();
  for (const status of items.map(item => ({
    name: item.status,
    stateCategory: item.stateCategory
  }))) {
    const key = kanbanLaneKey(status.name, status.stateCategory);
    visible.set(key, {
      key,
      name: status.name,
      category: status.stateCategory
    });
  }
  const targets = new Map<string, KanbanLane>();
  for (const status of discovered) {
    const key = kanbanLaneKey(status.name, status.stateCategory);
    if (visible.has(key)) continue;
    targets.set(key, {
      key,
      name: status.name,
      category: status.stateCategory
    });
  }
  const byWorkflow = (left: KanbanLane, right: KanbanLane) =>
    STATE_CATEGORY_ORDER.indexOf(left.category) -
      STATE_CATEGORY_ORDER.indexOf(right.category) ||
    left.name.localeCompare(right.name);
  return [
    ...[...visible.values()].sort(byWorkflow),
    ...[...targets.values()].sort(byWorkflow)
  ];
}

function kanbanItemId(item: WorkItem): string {
  return `${item.bbProjectId}:${item.source}:${item.locator}`;
}

function KanbanCard({
  item,
  pickedUp,
  pending,
  onOpen,
  onPrepare,
  onDragStart,
  onDragEnd,
  onKeyDown
}: {
  item: WorkItem;
  pickedUp: boolean;
  pending: boolean;
  onOpen: () => void;
  onPrepare: () => void;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const priority = /^(no priority|none)$/i.test(item.priority?.trim() ?? '')
    ? null
    : item.priority;
  const assignee = /^unassigned$/i.test(item.assignee?.trim() ?? '')
    ? null
    : item.assignee;
  const labels = item.labels
    .map(label => label.trim())
    .filter(Boolean)
    .slice(0, 2);

  return (
    <button
      type="button"
      draggable={!pending}
      aria-grabbed={pickedUp}
      aria-busy={pending}
      aria-label={`${item.key}: ${item.title}. Status ${item.status}. Source ${sourceName(item.source)}. Press Space to move, or Enter to open.`}
      data-source={item.source}
      data-state-category={item.stateCategory}
      data-picked-up={pickedUp ? 'true' : 'false'}
      data-pending={pending ? 'true' : 'false'}
      onPointerDown={onPrepare}
      onFocus={onPrepare}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      onClick={onOpen}
      className="wt-kanban-card group w-full rounded-md px-3 py-2.5 text-left transition-[border-color,background-color,opacity,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-2 text-xs">
        <span className="wt-key min-w-0 truncate font-medium tabular-nums">
          {item.key}
        </span>
        <span
          data-source={item.source}
          className="wt-source-label ml-auto shrink-0 text-[11px] font-medium"
        >
          {sourceName(item.source)}
        </span>
      </span>
      <span className="mt-1.5 flex items-start gap-1.5">
        <span className="mt-1 flex shrink-0">
          <StateDot category={item.stateCategory} />
        </span>
        <span className="line-clamp-2 block text-sm font-medium leading-snug text-foreground">
          {item.title}
        </span>
      </span>
      {labels.length > 0 ? (
        <span className="mt-2 flex min-w-0 gap-1 overflow-hidden">
          {labels.map((label, index) => (
            <span
              key={`${label}-${index}`}
              className="wt-label-chip min-w-0 truncate rounded-full px-2 py-0.5 text-xs"
              title={label}
            >
              {label}
            </span>
          ))}
        </span>
      ) : null}
      <span className="wt-meta mt-2 flex min-w-0 items-center gap-2 text-xs">
        <time className="shrink-0 tabular-nums" dateTime={item.updatedAt}>
          Updated {formatUpdatedAt(item.updatedAt)}
        </time>
        {priority ? (
          <span className="wt-priority-label shrink-0">{priority}</span>
        ) : null}
        {pending || assignee ? (
          <span className="ml-auto min-w-0 truncate">
            {pending ? 'Updating…' : assignee}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function KanbanBoard({
  items,
  onOpen,
  onMove
}: {
  items: readonly WorkItem[];
  onOpen: (item: WorkItem) => void;
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
}) {
  const rpc = useRpc<WorkTrackerRpcContract>();
  const optionsRef = useRef(
    new Map<string, Promise<readonly WorkStatusOption[]>>()
  );
  const draggedItemRef = useRef<WorkItem | null>(null);
  const suppressOpenRef = useRef<string | null>(null);
  const [discovered, setDiscovered] = useState<WorkStatusOption[]>([]);
  const [pickup, setPickup] = useState<{
    item: WorkItem;
    options: readonly WorkStatusOption[];
    targetLane: string | null;
    mode: 'pointer' | 'keyboard';
  } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [visibleMessage, setVisibleMessage] = useState<string | null>(null);
  const lanes = useMemo(
    () => kanbanLanes(items, discovered),
    [discovered, items]
  );

  const loadOptions = useCallback(
    (item: WorkItem) => {
      const itemId = kanbanItemId(item);
      const existing = optionsRef.current.get(itemId);
      if (existing) return existing;
      const request = rpc
        .call('statusOptions', {
          projectId: item.bbProjectId,
          source: item.source,
          locator: item.locator
        })
        .then(result => result.options)
        .catch((error: unknown) => {
          optionsRef.current.delete(itemId);
          throw error;
        });
      optionsRef.current.set(itemId, request);
      return request;
    },
    [rpc]
  );

  const beginPickup = useCallback(
    async (item: WorkItem, mode: 'pointer' | 'keyboard') => {
      const itemId = kanbanItemId(item);
      setPickup({ item, options: [], targetLane: null, mode });
      setChecking(itemId);
      setVisibleMessage(null);
      setAnnouncement(`Checking valid statuses for ${item.key}`);
      try {
        const options = await loadOptions(item);
        const targets = options.filter(option => !option.current);
        setDiscovered(current =>
          kanbanLanes([], [...current, ...options]).map(lane => ({
            id: lane.key,
            name: lane.name,
            stateCategory: lane.category,
            current: false
          }))
        );
        if (targets.length === 0) {
          const message = `${item.key} has no available status moves.`;
          setPickup(null);
          setVisibleMessage(message);
          setAnnouncement(message);
          return;
        }
        const targetLane = kanbanLaneKey(
          targets[0]!.name,
          targets[0]!.stateCategory
        );
        setPickup(current =>
          current && kanbanItemId(current.item) === itemId
            ? {
                ...current,
                options,
                targetLane: current.targetLane ?? targetLane
              }
            : current
        );
        setAnnouncement(
          `${item.key} picked up. ${targets.length} status ${targets.length === 1 ? 'target' : 'targets'} available. ${targets[0]!.name} selected.`
        );
      } catch (error) {
        const message = describeError(error);
        setPickup(null);
        setVisibleMessage(message);
        setAnnouncement(`Could not move ${item.key}. ${message}`);
      } finally {
        setChecking(current => (current === itemId ? null : current));
      }
    },
    [loadOptions]
  );

  const optionForLane = useCallback(
    (laneKey: string) =>
      pickup?.options.find(
        option =>
          !option.current &&
          kanbanLaneKey(option.name, option.stateCategory) === laneKey
      ),
    [pickup]
  );

  const commitMove = useCallback(
    async (
      item: WorkItem,
      laneKey: string,
      knownOptions: readonly WorkStatusOption[] = []
    ) => {
      if (pending) return;
      const itemId = kanbanItemId(item);
      let option = knownOptions.find(
        candidate =>
          !candidate.current &&
          kanbanLaneKey(candidate.name, candidate.stateCategory) === laneKey
      );
      if (!option) {
        try {
          const options = await loadOptions(item);
          option = options.find(
            candidate =>
              !candidate.current &&
              kanbanLaneKey(candidate.name, candidate.stateCategory) === laneKey
          );
        } catch (error) {
          const message = describeError(error);
          setPickup(null);
          setVisibleMessage(message);
          setAnnouncement(`Could not move ${item.key}. ${message}`);
          return;
        }
      }
      if (!option) {
        const message = `${item.key} cannot move to that status.`;
        setPickup(null);
        setVisibleMessage(message);
        setAnnouncement(message);
        return;
      }
      setPending(itemId);
      setPickup(null);
      setVisibleMessage(null);
      setAnnouncement(`Moving ${item.key} to ${option.name}`);
      try {
        await onMove(item, option);
        optionsRef.current.delete(itemId);
        setAnnouncement(`${item.key} moved to ${option.name}`);
      } catch (error) {
        optionsRef.current.delete(itemId);
        const message = describeError(error);
        setVisibleMessage(`${item.key} stayed in ${item.status}. ${message}`);
        setAnnouncement(`${item.key} move failed. ${message}`);
      } finally {
        setPending(current => (current === itemId ? null : current));
      }
    },
    [loadOptions, onMove, pending]
  );

  const keyboardTargets =
    pickup?.options.filter(option => !option.current) ?? [];

  return (
    <div
      role="region"
      aria-label="Kanban board"
      className="wt-kanban-area h-full min-h-0 overflow-auto p-2"
    >
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
      {visibleMessage ? (
        <div
          role="alert"
          className="wt-kanban-feedback sticky left-0 top-0 z-30 mb-2 w-fit max-w-lg rounded-md border px-2.5 py-1.5 text-xs text-destructive"
        >
          {visibleMessage}
        </div>
      ) : null}
      {lanes.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No external statuses in the current results
        </div>
      ) : (
        <div className="mx-auto flex min-h-full min-w-max max-w-[110rem] gap-2.5">
          {lanes.map(lane => {
            const columnItems = items.filter(
              item =>
                kanbanLaneKey(item.status, item.stateCategory) === lane.key
            );
            const option = optionForLane(lane.key);
            const dropState = pickup
              ? pickup.options.length === 0
                ? pickup.targetLane === lane.key
                  ? 'checking'
                  : 'invalid'
                : option
                  ? pickup.targetLane === lane.key
                    ? 'target'
                    : 'valid'
                  : 'invalid'
              : 'idle';
            const headingId = `kanban-${encodeURIComponent(lane.key)}`;
            return (
              <section
                key={lane.key}
                aria-labelledby={headingId}
                aria-dropeffect={
                  pickup && (pickup.options.length === 0 || option)
                    ? 'move'
                    : 'none'
                }
                data-drop-state={dropState}
                data-state-category={lane.category}
                onDragOver={event => {
                  if (!pickup && !draggedItemRef.current) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setPickup(current =>
                    current ? { ...current, targetLane: lane.key } : current
                  );
                }}
                onDrop={event => {
                  event.preventDefault();
                  const item = draggedItemRef.current ?? pickup?.item;
                  draggedItemRef.current = null;
                  if (item) {
                    void commitMove(item, lane.key, pickup?.options);
                  }
                }}
                className="wt-kanban-column flex w-[264px] min-w-[264px] flex-col rounded-lg border border-transparent"
              >
                <div className="wt-kanban-column-header sticky top-0 z-10 flex h-8 items-center gap-2 px-1">
                  <StateDot category={lane.category} />
                  <h3
                    id={headingId}
                    className="min-w-0 truncate text-xs font-semibold"
                  >
                    {lane.name}
                  </h3>
                  <span
                    aria-label={`${columnItems.length} ${columnItems.length === 1 ? 'item' : 'items'}`}
                    className="wt-lane-count ml-auto text-xs tabular-nums"
                  >
                    {columnItems.length}
                  </span>
                </div>
                <div className="min-h-20 flex-1 space-y-1.5 p-1.5 pt-1">
                  {columnItems.length > 0 ? (
                    columnItems.map(item => {
                      const itemId = kanbanItemId(item);
                      return (
                        <KanbanCard
                          key={itemId}
                          item={item}
                          pickedUp={
                            pickup
                              ? kanbanItemId(pickup.item) === itemId
                              : false
                          }
                          pending={pending === itemId}
                          onPrepare={() => {
                            void loadOptions(item).catch(() => undefined);
                          }}
                          onDragStart={event => {
                            if (pending || checking) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', itemId);
                            draggedItemRef.current = item;
                            suppressOpenRef.current = itemId;
                            void beginPickup(item, 'pointer');
                          }}
                          onDragEnd={() => {
                            draggedItemRef.current = null;
                            setPickup(current =>
                              current?.mode === 'pointer' ? null : current
                            );
                            window.setTimeout(() => {
                              if (suppressOpenRef.current === itemId) {
                                suppressOpenRef.current = null;
                              }
                            }, 0);
                          }}
                          onKeyDown={event => {
                            const isThisPickup =
                              pickup && kanbanItemId(pickup.item) === itemId;
                            if (!isThisPickup && event.key === ' ') {
                              event.preventDefault();
                              void beginPickup(item, 'keyboard');
                              return;
                            }
                            if (!isThisPickup) return;
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setPickup(null);
                              setAnnouncement(`${item.key} move canceled`);
                              return;
                            }
                            if (
                              event.key === 'ArrowLeft' ||
                              event.key === 'ArrowRight'
                            ) {
                              event.preventDefault();
                              const currentIndex = keyboardTargets.findIndex(
                                target =>
                                  kanbanLaneKey(
                                    target.name,
                                    target.stateCategory
                                  ) === pickup.targetLane
                              );
                              const direction =
                                event.key === 'ArrowRight' ? 1 : -1;
                              const next =
                                keyboardTargets[
                                  (currentIndex +
                                    direction +
                                    keyboardTargets.length) %
                                    keyboardTargets.length
                                ];
                              if (!next) return;
                              const targetLane = kanbanLaneKey(
                                next.name,
                                next.stateCategory
                              );
                              setPickup(current =>
                                current ? { ...current, targetLane } : current
                              );
                              setAnnouncement(
                                `${next.name} selected for ${item.key}`
                              );
                              return;
                            }
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              if (pickup.targetLane) {
                                void commitMove(
                                  pickup.item,
                                  pickup.targetLane,
                                  pickup.options
                                );
                              }
                            }
                          }}
                          onOpen={() => {
                            if (suppressOpenRef.current === itemId) {
                              suppressOpenRef.current = null;
                              return;
                            }
                            if (!pickup) onOpen(item);
                          }}
                        />
                      );
                    })
                  ) : (
                    <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                      {dropState === 'target' ? 'Drop to move here' : 'No work'}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TrackerList({
  projectId,
  projects,
  refreshGeneration,
  preferenceScope,
  initialPreferences,
  onPreferencesChange,
  onOpen
}: {
  projectId: string | null;
  projects: readonly TrackerProject[] | undefined;
  refreshGeneration: number;
  preferenceScope: string;
  initialPreferences: TrackerBrowsePreferences | undefined;
  onPreferencesChange: (
    scope: string,
    preferences: TrackerBrowsePreferences
  ) => void;
  onOpen: (item: WorkItem) => void;
}) {
  const rpc = useRpc<WorkTrackerRpcContract>();
  const [items, setItems] = useState<WorkItem[] | undefined>();
  const [source, setSource] = useState<SourceFilter>(
    initialPreferences?.source ?? ALL_SOURCES
  );
  const [stateCategories, setStateCategories] = useState<WorkStateCategory[]>(
    initialPreferences?.stateCategories ?? []
  );
  const [query, setQuery] = useState(initialPreferences?.query ?? '');
  const [committedQuery, setCommittedQuery] = useState(
    initialPreferences?.committedQuery ?? ''
  );
  const [view, setView] = useState<TrackerView>(
    initialPreferences?.view ?? 'list'
  );
  const [error, setError] = useState<string | null>(null);
  const requestRevisionRef = useRef(0);

  const loadItems = useCallback(async () => {
    const requestRevision = ++requestRevisionRef.current;
    setError(null);
    try {
      const result = await rpc.call('listItems', {
        ...(projectId === null ? {} : { projectId }),
        ...(source === ALL_SOURCES ? {} : { source }),
        ...(committedQuery.trim() ? { query: committedQuery.trim() } : {}),
        ...(stateCategories.length > 0 ? { stateCategories } : {})
      });
      if (requestRevision !== requestRevisionRef.current) return;
      setItems(result.items);
    } catch (nextError) {
      if (requestRevision !== requestRevisionRef.current) return;
      setError(describeError(nextError));
      setItems([]);
    }
  }, [rpc, projectId, source, committedQuery, stateCategories]);

  useEffect(() => {
    void loadItems();
  }, [loadItems, refreshGeneration]);
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setCommittedQuery(query.trim()),
      160
    );
    return () => window.clearTimeout(timeout);
  }, [query]);
  useEffect(() => {
    onPreferencesChange(preferenceScope, {
      source,
      stateCategories,
      query,
      committedQuery,
      view
    });
  }, [
    committedQuery,
    onPreferencesChange,
    preferenceScope,
    query,
    source,
    stateCategories,
    view
  ]);
  useEffect(
    () => () => {
      requestRevisionRef.current += 1;
    },
    []
  );
  useRealtime('work-tracker:changed', payload => {
    const changedProject = changedProjectId(payload);
    if (
      projectId === null ||
      changedProject === null ||
      changedProject === projectId
    ) {
      void loadItems();
    }
  });
  useRefreshOnReconnect(() => void loadItems());

  const projectsById = useMemo(
    () => new Map((projects ?? []).map(project => [project.id, project])),
    [projects]
  );
  const acrossProjectGroups = useMemo(
    () =>
      (projects ?? []).flatMap(project => {
        const projectItems = (items ?? []).filter(
          item => item.bbProjectId === project.id
        );
        return projectItems.length > 0
          ? [{ project, items: projectItems }]
          : [];
      }),
    [items, projects]
  );
  const duplicateProjectNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects ?? []) {
      counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name)
    );
  }, [projects]);
  const filtered =
    source !== ALL_SOURCES ||
    stateCategories.length > 0 ||
    committedQuery.trim() !== '';
  const clearFilters = () => {
    setSource(ALL_SOURCES);
    setStateCategories([]);
    setQuery('');
    setCommittedQuery('');
  };
  const moveItemStatus = useCallback(
    async (item: WorkItem, option: WorkStatusOption) => {
      const matches = (candidate: WorkItem) =>
        candidate.bbProjectId === item.bbProjectId &&
        candidate.source === item.source &&
        candidate.locator === item.locator;
      setItems(current =>
        current?.map(candidate =>
          matches(candidate)
            ? {
                ...candidate,
                status: option.name,
                stateCategory: option.stateCategory
              }
            : candidate
        )
      );
      try {
        const result = await rpc.call('updateItemStatus', {
          projectId: item.bbProjectId,
          source: item.source,
          locator: item.locator,
          statusId: option.id
        });
        setItems(current =>
          current?.map(candidate =>
            matches(candidate) ? result.item : candidate
          )
        );
      } catch (error) {
        setItems(current =>
          current?.map(candidate => (matches(candidate) ? item : candidate))
        );
        throw error;
      }
    },
    [rpc]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="wt-frame mx-auto flex h-full min-h-0 w-full max-w-[100rem] flex-col overflow-hidden">
        <TrackerFilterBar
          source={source}
          stateCategories={stateCategories}
          query={query}
          view={view}
          showViewToggle={projectId !== null}
          onSourceChange={setSource}
          onStateCategoriesChange={setStateCategories}
          onQueryChange={setQuery}
          onViewChange={setView}
          onClear={clearFilters}
        />
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {items === undefined
            ? 'Loading work items'
            : error
              ? 'Work items could not be loaded'
              : items.length === 0
                ? filtered
                  ? 'No work items match the current filters'
                  : 'No work items available'
                : `${items.length} ${items.length === 1 ? 'work item' : 'work items'} shown`}
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto @container">
          {items === undefined ? (
            <LoadingRows />
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Icon name="AlertCircle" className="size-5 text-destructive" />
              <p className="text-sm font-medium">Could not load work items</p>
              <p role="alert" className="max-w-md text-sm text-destructive">
                {error}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setItems(undefined);
                  void loadItems();
                }}
              >
                Try again
              </Button>
            </div>
          ) : projectId !== null && view === 'kanban' ? (
            <KanbanBoard
              key={projectId}
              items={items}
              onOpen={onOpen}
              onMove={moveItemStatus}
            />
          ) : items.length === 0 ? (
            <EmptyState filtered={filtered} onClear={clearFilters} />
          ) : projectId === null ? (
            acrossProjectGroups.map(({ project, items: projectItems }) => (
              <section
                key={project.id}
                aria-labelledby={`project-${project.id}`}
                className="border-b border-border last:border-b-0"
              >
                <h2
                  id={`project-${project.id}`}
                  className="wt-project-strip sticky top-0 z-20 flex h-8 items-center gap-2 border-b px-2.5 text-xs font-semibold"
                >
                  <Icon
                    name="Folder"
                    className="size-3.5 text-muted-foreground"
                  />
                  {project.name}
                  {duplicateProjectNames.has(project.name) ? (
                    <span className="truncate font-mono text-xs font-normal text-muted-foreground">
                      {project.id}
                    </span>
                  ) : null}
                </h2>
                <ListStateGroups
                  items={projectItems}
                  projectsById={projectsById}
                  showProject={false}
                  idPrefix={project.id}
                  nested
                  onOpen={onOpen}
                />
              </section>
            ))
          ) : (
            <ListStateGroups
              items={items}
              projectsById={projectsById}
              showProject={false}
              idPrefix={projectId ?? 'selected-project'}
              onOpen={onOpen}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DetailMetadata({
  item,
  className
}: {
  item: WorkItemDetail;
  className?: string;
}) {
  const fields = [
    ['Source', sourceName(item.source)],
    ['Status', item.status],
    ['Priority', item.priority ?? 'None'],
    ['Assignee', item.assignee ?? 'Unassigned'],
    ['External project', item.project ?? 'None'],
    ['Updated', formatUpdatedAt(item.updatedAt)]
  ] as const;
  return (
    <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-3', className)}>
      {fields.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="truncate text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TrackerDetail({
  route,
  refreshGeneration
}: {
  route: Extract<TrackerRoute, { kind: 'item' }>;
  refreshGeneration: number;
}) {
  const rpc = useRpc<WorkTrackerRpcContract>();
  const navigate = useBbNavigate();
  const [item, setItem] = useState<WorkItemDetail | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const requestRevisionRef = useRef(0);

  const load = useCallback(async () => {
    const requestRevision = ++requestRevisionRef.current;
    setError(null);
    try {
      const result = await rpc.call('getItem', {
        projectId: route.projectId,
        source: route.source,
        locator: route.locator
      });
      if (requestRevision !== requestRevisionRef.current) return;
      setItem(result.item);
    } catch (nextError) {
      if (requestRevision !== requestRevisionRef.current) return;
      setItem(null);
      setError(describeError(nextError));
    }
  }, [rpc, route.projectId, route.source, route.locator]);

  useEffect(() => {
    setItem(undefined);
    void load();
    return () => {
      requestRevisionRef.current += 1;
    };
  }, [load, refreshGeneration]);
  useRealtime('work-tracker:changed', payload => {
    const changedProject = changedProjectId(payload);
    if (changedProject === null || changedProject === route.projectId) {
      void load();
    }
  });
  useRefreshOnReconnect(() => void load());

  if (item === undefined) {
    return (
      <div className="space-y-4 p-4 md:p-5">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }

  if (item === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="AlertCircle" className="size-6 text-destructive" />
        <p className="text-sm font-medium">Could not load this work item</p>
        <p role="alert" className="max-w-md text-sm text-muted-foreground">
          {error}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setItem(undefined);
            void load();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const prompt = [
    `Work on ${sourceName(item.source)} issue ${item.key}: ${item.title}`,
    '',
    `External issue: ${item.url}`,
    `BB project: ${item.bbProjectId}`,
    `Status: ${item.status}`,
    '',
    item.description
  ].join('\n');

  return (
    <div className="@container flex min-h-full flex-col p-3">
      <div className="wt-detail-frame flex flex-1 items-stretch rounded-lg border">
        <article className="mx-auto w-full min-w-0 max-w-[55rem] flex-1 px-7 pb-16 pt-8 @3xl:px-13 @3xl:pt-11">
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium tabular-nums">{item.key}</span>
            <Badge
              variant={statusTone(item.stateCategory)}
              data-state-category={item.stateCategory}
              className="wt-status-pill"
            >
              {item.status}
            </Badge>
            <Badge
              variant="outline"
              data-source={item.source}
              className="wt-source-chip"
            >
              {sourceName(item.source)}
            </Badge>
          </div>
          <div className="flex flex-col gap-4 @lg:flex-row @lg:items-start">
            <h1 className="min-w-0 flex-1 text-2xl font-semibold leading-tight">
              {item.title}
            </h1>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={item.url} target="_blank" rel="noreferrer">
                  <Icon name="ExternalLink" className="size-3.5" />
                  Open
                </a>
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  navigate.toCompose({
                    initialPrompt: prompt,
                    focusPrompt: true
                  })
                }
              >
                <Icon name="AiContentGenerator01" className="size-3.5" />
                Send to agent
              </Button>
            </div>
          </div>

          <DetailMetadata
            item={item}
            className="wt-detail-meta mt-5 rounded-lg border p-4 @[45rem]:hidden"
          />

          {item.labels.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-1.5">
              {item.labels.map(label => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </div>
          ) : null}

          <section className="mt-7">
            <h2 className="mb-3 text-sm font-semibold">Description</h2>
            {item.description.trim() ? (
              <Markdown content={item.description} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No description provided.
              </p>
            )}
          </section>

          {item.comments.length > 0 ? (
            <section className="mt-8 space-y-3">
              <h2 className="text-sm font-semibold">Comments</h2>
              {item.comments.map((comment, index) => (
                <article
                  key={`${comment.author}:${comment.createdAt}:${index}`}
                  className="wt-comment-card rounded-lg border p-4"
                >
                  <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {comment.author}
                    </span>
                    <time>{formatUpdatedAt(comment.createdAt)}</time>
                  </div>
                  <Markdown content={comment.body} />
                </article>
              ))}
            </section>
          ) : null}
        </article>

        <aside className="hidden w-56 shrink-0 border-l border-border-hairline py-10 pl-4 pr-6 @[45rem]:block">
          <DetailMetadata item={item} className="grid-cols-1" />
        </aside>
      </div>
    </div>
  );
}

function configFingerprint(config: ProjectConfigView): string {
  return JSON.stringify({
    githubEnabled: config.githubEnabled,
    linearEnabled: config.linearEnabled,
    linearTeamKey: config.linearTeamKey,
    jiraEnabled: config.jiraEnabled,
    jiraBaseUrl: config.jiraBaseUrl,
    jiraEmail: config.jiraEmail,
    jiraJql: config.jiraJql
  });
}

function secretMutation(value: string, remove: boolean): SecretMutation {
  if (value.trim()) return { operation: 'set', value: value.trim() };
  return remove ? { operation: 'clear' } : { operation: 'keep' };
}

function CredentialStatus({
  configured,
  hasDraft,
  remove
}: {
  configured: boolean;
  hasDraft: boolean;
  remove: boolean;
}) {
  const label = remove
    ? 'Removal queued'
    : hasDraft
      ? configured
        ? 'Replacement ready'
        : 'Credential ready'
      : configured
        ? 'Configured'
        : 'Not configured';
  return (
    <span
      className={cn(
        'wt-status-pill inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        configured && !remove
          ? 'border-success/30 bg-success/10 text-success'
          : 'text-muted-foreground'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          configured && !remove ? 'bg-success' : 'bg-muted-foreground/60'
        )}
      />
      {label}
    </span>
  );
}

function ProjectConfigForm({
  initialConfig,
  onSave,
  onSavingChange
}: {
  initialConfig: ProjectConfigView;
  onSave: (mutation: ProjectConfigMutation) => Promise<ProjectConfigView>;
  onSavingChange: (saving: boolean) => void;
}) {
  const [baseline, setBaseline] = useState(initialConfig);
  const [config, setConfig] = useState(initialConfig);
  const [linearDraft, setLinearDraft] = useState('');
  const [jiraDraft, setJiraDraft] = useState('');
  const [removeLinear, setRemoveLinear] = useState(false);
  const [removeJira, setRemoveJira] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linearEnabledBeforeRemoveRef = useRef(initialConfig.linearEnabled);
  const jiraEnabledBeforeRemoveRef = useRef(initialConfig.jiraEnabled);

  useEffect(() => {
    setBaseline(initialConfig);
    setConfig(initialConfig);
    setLinearDraft('');
    setJiraDraft('');
    setRemoveLinear(false);
    setRemoveJira(false);
    linearEnabledBeforeRemoveRef.current = initialConfig.linearEnabled;
    jiraEnabledBeforeRemoveRef.current = initialConfig.jiraEnabled;
    setSaving(false);
    setSaved(false);
    setError(null);
  }, [initialConfig]);
  useEffect(
    () => () => {
      onSavingChange(false);
    },
    [onSavingChange]
  );

  const dirty =
    configFingerprint(config) !== configFingerprint(baseline) ||
    linearDraft.trim() !== '' ||
    jiraDraft.trim() !== '' ||
    removeLinear ||
    removeJira;
  const save = async () => {
    if (saving || !dirty) return;
    setSaved(false);
    setError(null);

    const linearCredential = secretMutation(linearDraft, removeLinear);
    const jiraCredential = secretMutation(jiraDraft, removeJira);
    const linearWillBeConfigured =
      linearCredential.operation === 'set' ||
      (baseline.linearCredentialConfigured &&
        linearCredential.operation === 'keep');
    const jiraWillBeConfigured =
      jiraCredential.operation === 'set' ||
      (baseline.jiraCredentialConfigured &&
        jiraCredential.operation === 'keep');

    if (config.linearEnabled) {
      if (!config.linearTeamKey.trim()) {
        setError('Add a Linear team key or turn Linear off for this project.');
        return;
      }
      if (!linearWillBeConfigured) {
        setError('Add a Linear API key or turn Linear off for this project.');
        return;
      }
    }
    const parsedUrl = jiraBaseUrlSchema.safeParse(config.jiraBaseUrl.trim());
    if (!parsedUrl.success) {
      setError('Jira URL must be an HTTPS atlassian.net origin.');
      return;
    }
    const jiraBaseUrl = parsedUrl.data;
    const jiraIdentityChanged =
      jiraBaseUrl !== baseline.jiraBaseUrl ||
      config.jiraEmail.trim() !== baseline.jiraEmail;
    if (config.jiraEnabled) {
      if (!config.jiraEmail.trim()) {
        setError('Add the Jira account email for this project.');
        return;
      }
      if (!config.jiraJql.trim()) {
        setError('Add a Jira JQL query for this project.');
        return;
      }
      if (!jiraWillBeConfigured) {
        setError('Add a Jira API token or turn Jira off for this project.');
        return;
      }
    }
    if (
      jiraIdentityChanged &&
      baseline.jiraCredentialConfigured &&
      jiraCredential.operation === 'keep'
    ) {
      setError(
        'Changing the Jira site or email requires a replacement token or explicit credential removal.'
      );
      return;
    }

    setSaving(true);
    onSavingChange(true);
    try {
      const result = await onSave({
        projectId: config.projectId,
        githubEnabled: config.githubEnabled,
        linearEnabled: config.linearEnabled,
        linearTeamKey: config.linearTeamKey.trim(),
        jiraEnabled: config.jiraEnabled,
        jiraBaseUrl,
        jiraEmail: config.jiraEmail.trim(),
        jiraJql: config.jiraJql.trim(),
        linearCredential,
        jiraCredential
      });
      setBaseline(result);
      setConfig(result);
      setLinearDraft('');
      setJiraDraft('');
      setRemoveLinear(false);
      setRemoveJira(false);
      linearEnabledBeforeRemoveRef.current = result.linearEnabled;
      jiraEnabledBeforeRemoveRef.current = result.jiraEnabled;
      setSaved(true);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  };

  const cardClass = 'wt-settings-card rounded-lg border p-4 @lg:p-5';
  return (
    <form
      className="space-y-3"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <section className={cardClass} aria-labelledby="github-connector-title">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md border border-border bg-secondary">
                <Icon name="Github" className="size-4" />
              </span>
              <h3 id="github-connector-title" className="text-sm font-semibold">
                GitHub
              </h3>
            </div>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              Uses this BB project&apos;s repository mapping and the official
              GitHub connection. Work Tracker never stores a GitHub token.
            </p>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              {config.githubRepos.length > 0
                ? 'Mapped repositories for this BB project'
                : 'No GitHub repositories are currently mapped to this BB project.'}
            </p>
            {config.githubRepos.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {config.githubRepos.map(repo => (
                  <span
                    key={repo}
                    data-source="github"
                    className="wt-source-chip rounded-full px-2 py-0.5 font-mono text-[11px]"
                  >
                    {repo}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <Switch
            aria-label="Include GitHub issues"
            checked={config.githubEnabled}
            disabled={saving}
            onCheckedChange={githubEnabled => {
              setConfig({ ...config, githubEnabled });
              setSaved(false);
            }}
          />
        </div>
      </section>

      <section className={cardClass} aria-labelledby="linear-connector-title">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md border border-border bg-secondary">
                <Icon name="Circle" className="size-4" />
              </span>
              <h3 id="linear-connector-title" className="text-sm font-semibold">
                Linear
              </h3>
              <CredentialStatus
                configured={baseline.linearCredentialConfigured}
                hasDraft={linearDraft.trim() !== ''}
                remove={removeLinear}
              />
            </div>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              This API key belongs only to this BB project. A team key is
              required so the project cannot silently mix work from other teams.
            </p>
          </div>
          <Switch
            aria-label="Include Linear issues"
            checked={config.linearEnabled}
            disabled={saving}
            onCheckedChange={linearEnabled => {
              setConfig({ ...config, linearEnabled });
              setSaved(false);
            }}
          />
        </div>
        <div className="mt-4 grid gap-3 @lg:grid-cols-2">
          <label className="space-y-1.5 text-xs font-medium">
            Linear API key{' '}
            <span className="font-normal text-muted-foreground">
              (write-only)
            </span>
            <Input
              type="password"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Linear API key"
              value={linearDraft}
              placeholder={
                baseline.linearCredentialConfigured
                  ? 'Enter to replace current key'
                  : 'Enter project API key'
              }
              className="wt-field"
              disabled={saving || removeLinear}
              onChange={event => {
                setLinearDraft(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <label className="space-y-1.5 text-xs font-medium">
            Linear team key{' '}
            <span className="font-normal text-muted-foreground">
              (required when enabled)
            </span>
            <Input
              aria-label="Linear team key"
              value={config.linearTeamKey}
              placeholder="ENG"
              className="wt-field wt-field-mono"
              disabled={saving}
              onChange={event => {
                setConfig({ ...config, linearTeamKey: event.target.value });
                setSaved(false);
              }}
            />
          </label>
        </div>
        {baseline.linearCredentialConfigured ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-3 text-destructive hover:text-destructive"
            disabled={saving}
            onClick={() => {
              const next = !removeLinear;
              if (next) {
                linearEnabledBeforeRemoveRef.current = config.linearEnabled;
              }
              setConfig(current => ({
                ...current,
                linearEnabled: next
                  ? false
                  : linearEnabledBeforeRemoveRef.current
              }));
              setRemoveLinear(next);
              setLinearDraft('');
              setSaved(false);
            }}
          >
            <Icon
              name={removeLinear ? 'RotateCcw' : 'Trash2'}
              className="size-3.5"
            />
            {removeLinear
              ? 'Keep Linear credential'
              : 'Remove Linear credential'}
          </Button>
        ) : null}
      </section>

      <section className={cardClass} aria-labelledby="jira-connector-title">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md border border-border bg-secondary">
                <Icon name="ListTodo" className="size-4" />
              </span>
              <h3 id="jira-connector-title" className="text-sm font-semibold">
                Jira
              </h3>
              <CredentialStatus
                configured={baseline.jiraCredentialConfigured}
                hasDraft={jiraDraft.trim() !== ''}
                remove={removeJira}
              />
            </div>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              Jira accepts HTTPS atlassian.net sites only. Changing the site or
              account email requires replacing or removing the token.
            </p>
          </div>
          <Switch
            aria-label="Include Jira issues"
            checked={config.jiraEnabled}
            disabled={saving}
            onCheckedChange={jiraEnabled => {
              setConfig({ ...config, jiraEnabled });
              setSaved(false);
            }}
          />
        </div>
        <div className="mt-4 grid gap-3 @lg:grid-cols-2">
          <label className="space-y-1.5 text-xs font-medium">
            Jira site
            <Input
              aria-label="Jira site"
              value={config.jiraBaseUrl}
              placeholder="https://workspace.atlassian.net"
              className="wt-field wt-field-mono"
              disabled={saving}
              onChange={event => {
                setConfig({ ...config, jiraBaseUrl: event.target.value });
                setSaved(false);
              }}
            />
          </label>
          <label className="space-y-1.5 text-xs font-medium">
            Jira account email
            <Input
              type="email"
              aria-label="Jira account email"
              value={config.jiraEmail}
              placeholder="you@example.com"
              className="wt-field"
              disabled={saving}
              onChange={event => {
                setConfig({ ...config, jiraEmail: event.target.value });
                setSaved(false);
              }}
            />
          </label>
          <label className="space-y-1.5 text-xs font-medium @lg:col-span-2">
            Jira API token{' '}
            <span className="font-normal text-muted-foreground">
              (write-only)
            </span>
            <Input
              type="password"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Jira API token"
              value={jiraDraft}
              placeholder={
                baseline.jiraCredentialConfigured
                  ? 'Enter to replace current token'
                  : 'Enter project API token'
              }
              className="wt-field"
              disabled={saving || removeJira}
              onChange={event => {
                setJiraDraft(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <label className="space-y-1.5 text-xs font-medium @lg:col-span-2">
            Jira JQL
            <Textarea
              aria-label="Jira JQL"
              value={config.jiraJql}
              placeholder='project = "BB" AND statusCategory != Done'
              className="wt-field min-h-24 font-mono text-xs"
              disabled={saving}
              onChange={event => {
                setConfig({ ...config, jiraJql: event.target.value });
                setSaved(false);
              }}
            />
          </label>
        </div>
        {baseline.jiraCredentialConfigured ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-3 text-destructive hover:text-destructive"
            disabled={saving}
            onClick={() => {
              const next = !removeJira;
              if (next) {
                jiraEnabledBeforeRemoveRef.current = config.jiraEnabled;
              }
              setConfig(current => ({
                ...current,
                jiraEnabled: next ? false : jiraEnabledBeforeRemoveRef.current
              }));
              setRemoveJira(next);
              setJiraDraft('');
              setSaved(false);
            }}
          >
            <Icon
              name={removeJira ? 'RotateCcw' : 'Trash2'}
              className="size-3.5"
            />
            {removeJira ? 'Keep Jira credential' : 'Remove Jira credential'}
          </Button>
        ) : null}
      </section>

      <div className="wt-save-bar sticky bottom-0 flex flex-wrap items-center justify-end gap-3 rounded-lg border px-4 py-3 backdrop-blur-sm">
        {error ? (
          <p role="alert" className="mr-auto max-w-xl text-sm text-destructive">
            {error}
          </p>
        ) : saved ? (
          <span role="status" className="mr-auto text-sm text-success">
            Project connection saved
          </span>
        ) : dirty ? (
          <span className="mr-auto text-xs text-muted-foreground">
            Unsaved project changes
          </span>
        ) : null}
        {error ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void save()}
          >
            Retry save
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save project connection'}
        </Button>
      </div>
    </form>
  );
}

function ManageView({
  projectId,
  projects,
  isLoadingProjects,
  onProjectChange
}: {
  projectId: string | null;
  projects: readonly TrackerProject[] | undefined;
  isLoadingProjects: boolean;
  onProjectChange: (projectId: string) => void;
}) {
  const rpc = useRpc<WorkTrackerRpcContract>();
  const [config, setConfig] = useState<ProjectConfigView | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);

  useEffect(() => {
    setConfig(null);
    setError(null);
    if (!projectId) return;
    let cancelled = false;
    setLoadingConfig(true);
    void rpc
      .call('getProjectConfig', { projectId })
      .then(result => {
        if (!cancelled) setConfig(result.config);
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(describeError(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRevision, projectId, rpc]);

  return (
    <div className="h-full overflow-y-auto p-3 @container">
      <div className="mx-auto w-full max-w-4xl space-y-4 pb-8">
        <header className="wt-manage-hero flex flex-col gap-3 rounded-lg border px-4 py-4 @lg:flex-row @lg:items-end @lg:justify-between @lg:px-5">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Project settings
            </p>
            <h2 className="text-lg font-semibold">External work sources</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Credentials and connector rules stay isolated to the selected BB
              project. Secret values are write-only and never loaded back here.
            </p>
          </div>
          {projects && projects.length > 0 ? (
            <Select
              value={projectId ?? undefined}
              disabled={savingConfig}
              onValueChange={onProjectChange}
            >
              <SelectTrigger
                aria-label="BB project"
                className="wt-field h-9 w-64 max-w-full"
              >
                <SelectValue placeholder="Choose a BB project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map(project => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </header>

        {isLoadingProjects || projects === undefined ? (
          <div className="space-y-3">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : projects.length === 0 || projectId === null ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card p-10 text-center">
            <Icon name="Folder" className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No BB projects found</p>
            <p className="text-sm text-muted-foreground">
              Create a BB project before configuring tracked sources.
            </p>
          </div>
        ) : loadingConfig ||
          (config !== null && config.projectId !== projectId) ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : config ? (
          <ProjectConfigForm
            key={config.projectId}
            initialConfig={config}
            onSavingChange={setSavingConfig}
            onSave={async mutation => {
              const result = await rpc.call('saveProjectConfig', mutation);
              return result.config;
            }}
          />
        ) : (
          <div className="rounded-xl border border-destructive/30 bg-card p-5">
            <p role="alert" className="text-sm text-destructive">
              {error ?? 'Could not load this project connection.'}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setLoadRevision(revision => revision + 1)}
            >
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkTrackerPanel({ subPath }: PluginNavPanelProps) {
  const route = parseTrackerRoute(subPath);
  const rpc = useRpc<WorkTrackerRpcContract>();
  const navigate = useBbNavigate();
  const { projectId: contextProjectId } = useBbContext();
  const rootRef = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<TrackerProject[] | undefined>();
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(loadSidebarCollapsed);
  const [narrow, setNarrow] = useState(false);
  const [narrowOverride, setNarrowOverride] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const projectsRequestRevisionRef = useRef(0);
  const browsePreferencesRef = useRef(
    new Map<string, TrackerBrowsePreferences>()
  );
  const lastBrowseRouteRef = useRef<Extract<
    TrackerRoute,
    { kind: 'all' | 'project' }
  > | null>(null);
  const preferredProjectId = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    if (
      contextProjectId &&
      projects.some(project => project.id === contextProjectId)
    ) {
      return contextProjectId;
    }
    const lastProjectId = loadLastProjectId();
    if (
      lastProjectId &&
      projects.some(project => project.id === lastProjectId)
    ) {
      return lastProjectId;
    }
    return projects[0]?.id ?? null;
  }, [contextProjectId, projects]);

  const loadProjects = useCallback(async () => {
    const requestRevision = ++projectsRequestRevisionRef.current;
    setProjectsError(null);
    try {
      const result = await rpc.call('listProjects', null);
      if (requestRevision !== projectsRequestRevisionRef.current) return null;
      setProjects(result.projects);
      return result.projects;
    } catch (nextError) {
      if (requestRevision !== projectsRequestRevisionRef.current) return null;
      setProjects([]);
      setProjectsError(describeError(nextError));
      return null;
    }
  }, [rpc]);
  const rememberBrowsePreferences = useCallback(
    (scope: string, preferences: TrackerBrowsePreferences) => {
      browsePreferencesRef.current.set(scope, preferences);
    },
    []
  );

  useEffect(() => {
    void loadProjects();
    return () => {
      projectsRequestRevisionRef.current += 1;
    };
  }, [loadProjects]);
  useRefreshOnReconnect(() => void loadProjects());

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const width = root.clientWidth;
      setNarrow(width > 0 && width < SIDEBAR_AUTO_COLLAPSE_WIDTH);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setNarrowOverride(null);
  }, [narrow]);
  useEffect(() => {
    if (route.kind === 'all' || route.kind === 'project') {
      lastBrowseRouteRef.current = route;
      if (route.kind === 'project') storeLastProjectId(route.projectId);
    }
  }, [subPath]);
  useEffect(() => {
    if (route.kind !== 'root' || preferredProjectId === null) return;
    storeLastProjectId(preferredProjectId);
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: routeToSubPath({
        kind: 'project',
        projectId: preferredProjectId
      }),
      replace: true
    });
  }, [navigate, preferredProjectId, route.kind]);
  useEffect(() => {
    if (
      route.kind !== 'manage' ||
      route.projectId !== null ||
      preferredProjectId === null
    ) {
      return;
    }
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: routeToSubPath({
        kind: 'manage',
        projectId: preferredProjectId
      }),
      replace: true
    });
  }, [navigate, preferredProjectId, route.kind, subPath]);

  const effectiveSidebarCollapsed = narrow
    ? (narrowOverride ?? true)
    : sidebarCollapsed;
  const sidebarOverlay = narrow && !effectiveSidebarCollapsed;

  const toggleSidebar = () => {
    const next = !effectiveSidebarCollapsed;
    if (narrow) setNarrowOverride(next);
    setSidebarCollapsed(next);
    storeSidebarCollapsed(next);
  };
  const go = (nextRoute: TrackerRoute) => {
    if (sidebarOverlay) setNarrowOverride(null);
    navigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(nextRoute) });
  };
  const backFromItem = () => {
    if (route.kind !== 'item') return;
    go(
      lastBrowseRouteRef.current ?? {
        kind: 'project',
        projectId: route.projectId
      }
    );
  };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const latestProjects = await loadProjects();
      const projectIds =
        route.kind === 'project' || route.kind === 'item'
          ? [route.projectId]
          : route.kind === 'root' && preferredProjectId
            ? [preferredProjectId]
            : (latestProjects ?? projects ?? []).map(project => project.id);
      await Promise.all(
        projectIds.map(projectId => rpc.call('refresh', { projectId }))
      );
      setRefreshGeneration(generation => generation + 1);
    } catch (nextError) {
      setRefreshError(describeError(nextError));
    } finally {
      setRefreshing(false);
    }
  };

  const sidebar = (
    <TrackerSidebar
      route={route}
      projects={projects}
      isLoading={projects === undefined}
      preferredProjectId={preferredProjectId}
      overlay={sidebarOverlay}
      onNavigate={go}
    />
  );

  let outlet: ReactNode;
  if (route.kind === 'root' && preferredProjectId === null) {
    outlet =
      projects === undefined ? (
        <div className="h-full bg-surface-recessed-solid p-3">
          <div className="mx-auto h-full max-w-[100rem] rounded-xl border border-border bg-card p-4">
            <LoadingRows />
          </div>
        </div>
      ) : (
        <EmptyState filtered={false} onClear={() => undefined} />
      );
  } else if (route.kind === 'manage') {
    outlet = (
      <ManageView
        projectId={route.projectId ?? preferredProjectId}
        projects={projects}
        isLoadingProjects={projects === undefined}
        onProjectChange={projectId => go({ kind: 'manage', projectId })}
      />
    );
  } else if (route.kind === 'item') {
    outlet = (
      <TrackerDetail route={route} refreshGeneration={refreshGeneration} />
    );
  } else {
    const projectId =
      route.kind === 'project'
        ? route.projectId
        : route.kind === 'root'
          ? preferredProjectId
          : null;
    const preferenceScope = projectId ?? 'across-projects';
    outlet = (
      <TrackerList
        key={projectId ?? 'all'}
        projectId={projectId}
        projects={projects}
        refreshGeneration={refreshGeneration}
        preferenceScope={preferenceScope}
        initialPreferences={browsePreferencesRef.current.get(preferenceScope)}
        onPreferencesChange={rememberBrowsePreferences}
        onOpen={item =>
          go({
            kind: 'item',
            projectId: item.bbProjectId,
            source: item.source,
            locator: item.locator
          })
        }
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className="wt-linear relative flex h-full min-h-0 flex-row-reverse text-foreground"
    >
      {!effectiveSidebarCollapsed ? (
        sidebarOverlay ? (
          <SidebarDrawer onClose={toggleSidebar}>{sidebar}</SidebarDrawer>
        ) : (
          sidebar
        )
      ) : null}
      <main className="@container flex min-w-0 flex-1 flex-col">
        <TrackerTopbar
          route={route}
          projects={projects}
          sidebarCollapsed={effectiveSidebarCollapsed}
          refreshing={refreshing}
          refreshDisabled={
            route.kind === 'manage' ||
            (route.kind === 'all' && projects === undefined)
          }
          onNavigate={go}
          onBack={backFromItem}
          onRefresh={() => void refresh()}
          onToggleSidebar={toggleSidebar}
        />
        {projectsError ? (
          <p
            role="alert"
            className="shrink-0 border-b border-border-hairline px-3.5 py-1.5 text-xs text-destructive"
          >
            {projectsError}
          </p>
        ) : null}
        {refreshError ? (
          <p
            role="alert"
            className="shrink-0 border-b border-border-hairline px-3.5 py-1.5 text-xs text-destructive"
          >
            {refreshError}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto">{outlet}</div>
      </main>
    </div>
  );
}

function ProjectCredentialsInteractionForm({
  interaction,
  submit,
  cancel
}: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () =>
      projectCredentialsInteractionPayloadSchema.safeParse(interaction.payload),
    [interaction.payload]
  );
  const [linearDraft, setLinearDraft] = useState('');
  const [jiraDraft, setJiraDraft] = useState('');
  const [removeLinear, setRemoveLinear] = useState(false);
  const [removeJira, setRemoveJira] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interactionIdRef = useRef(interaction.id);
  interactionIdRef.current = interaction.id;

  useEffect(() => {
    setLinearDraft('');
    setJiraDraft('');
    setRemoveLinear(false);
    setRemoveJira(false);
    setBusy(false);
    setError(null);
  }, [interaction.id]);

  if (!parsed.success) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-muted-foreground">
          This project credential request is invalid.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void cancel().catch(() => undefined)}
        >
          Cancel
        </Button>
      </div>
    );
  }
  const payload = parsed.data;
  const hasChanges =
    linearDraft.trim() !== '' ||
    jiraDraft.trim() !== '' ||
    removeLinear ||
    removeJira;
  const submitCredentials = async () => {
    const submittedInteractionId = interaction.id;
    const response: ProjectCredentialsInteractionResponse = {
      linearCredential: secretMutation(linearDraft, removeLinear),
      jiraCredential: secretMutation(jiraDraft, removeJira)
    };
    const validated =
      projectCredentialsInteractionResponseSchema.safeParse(response);
    if (!validated.success || !hasChanges) {
      setError('Enter or remove at least one project credential.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await submit(validated.data);
      if (interactionIdRef.current !== submittedInteractionId) return;
      setLinearDraft('');
      setJiraDraft('');
      setRemoveLinear(false);
      setRemoveJira(false);
    } catch {
      // The host renders submission failures outside the plugin form.
    } finally {
      if (interactionIdRef.current === submittedInteractionId) setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={event => {
        event.preventDefault();
        void submitCredentials();
      }}
    >
      <div className="space-y-1">
        <p className="text-sm font-semibold">{payload.projectName}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Credentials entered here are write-only and isolated to this BB
          project. Existing values are never loaded into the form.
        </p>
      </div>

      <dl className="grid gap-2 rounded-lg border border-border bg-surface-recessed p-3 text-xs sm:grid-cols-3">
        {[
          ['Linear team', payload.linearTeamKey || 'Not configured'],
          ['Jira site', payload.jiraBaseUrl || 'Not configured'],
          ['Jira account', payload.jiraEmail || 'Not configured']
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 space-y-0.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium text-foreground" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={`linear-${interaction.id}`}
              className="text-xs font-semibold"
            >
              Linear API key
            </label>
            <CredentialStatus
              configured={payload.linearCredentialConfigured}
              hasDraft={linearDraft.trim() !== ''}
              remove={removeLinear}
            />
          </div>
          <Input
            id={`linear-${interaction.id}`}
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={linearDraft}
            placeholder={
              payload.linearCredentialConfigured
                ? 'Enter to replace current key'
                : 'Enter project API key'
            }
            disabled={busy || removeLinear}
            onChange={event => {
              setLinearDraft(event.target.value);
              setError(null);
            }}
          />
          {payload.linearCredentialConfigured ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => {
                setRemoveLinear(value => !value);
                setLinearDraft('');
                setError(null);
              }}
            >
              {removeLinear
                ? 'Keep Linear credential'
                : 'Remove Linear credential'}
            </Button>
          ) : null}
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={`jira-${interaction.id}`}
              className="text-xs font-semibold"
            >
              Jira API token
            </label>
            <CredentialStatus
              configured={payload.jiraCredentialConfigured}
              hasDraft={jiraDraft.trim() !== ''}
              remove={removeJira}
            />
          </div>
          <Input
            id={`jira-${interaction.id}`}
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={jiraDraft}
            placeholder={
              payload.jiraCredentialConfigured
                ? 'Enter to replace current token'
                : 'Enter project API token'
            }
            disabled={busy || removeJira}
            onChange={event => {
              setJiraDraft(event.target.value);
              setError(null);
            }}
          />
          {payload.jiraCredentialConfigured ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => {
                setRemoveJira(value => !value);
                setJiraDraft('');
                setError(null);
              }}
            >
              {removeJira ? 'Keep Jira credential' : 'Remove Jira credential'}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 border-t border-border-hairline pt-4 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void cancel().catch(() => undefined)}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !hasChanges}>
          {busy ? 'Saving…' : 'Save credentials'}
        </Button>
      </div>
    </form>
  );
}

function ProjectCredentialsInteraction(props: PluginPendingInteractionProps) {
  return (
    <ProjectCredentialsInteractionForm key={props.interaction.id} {...props} />
  );
}

function ConnectionSettingsInfo() {
  return (
    <p className="text-sm text-muted-foreground">
      Linear and Jira credentials are isolated per BB project. Open Work
      Tracker, choose a project, then use Manage to configure its write-only
      credentials and connector rules.
    </p>
  );
}

export default definePluginApp(app => {
  app.slots.navPanel({
    id: 'tracker',
    title: 'Work Tracker',
    icon: 'ListTodo',
    path: PANEL_PATH,
    component: WorkTrackerPanel,
    headerContent: ManageHeaderAction
  });
  app.slots.settingsSection({
    id: 'connections',
    title: 'Project connections',
    description: 'Project-specific credentials for external work sources.',
    component: ConnectionSettingsInfo
  });
  app.slots.pendingInteraction({
    id: 'work-tracker-credentials',
    component: ProjectCredentialsInteraction
  });
});
