import { atom, useAtom, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { useCallback } from "react";
import type { PermissionMode, ReasoningLevel, ServiceTier } from "@bb/domain";
import {
  createLocalStorageEnumStorage,
  createLocalStorageSyncStorage,
  rawStringLocalStorage,
} from "@/lib/browser-storage";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";

const MODEL_STORAGE_KEY = "bb.promptbox.model";
const SERVICE_TIER_STORAGE_KEY = "bb.promptbox.service-tier";
const REASONING_STORAGE_KEY = "bb.promptbox.reasoning";
const PERMISSION_MODE_STORAGE_KEY = "bb.promptbox.permission-mode";
const ENVIRONMENT_STORAGE_KEY = "bb.promptbox.environment";
const PROVIDER_STORAGE_KEY = "bb.promptbox.provider";
const PROVIDER_SELECTION_STORAGE_VERSION = "1";
const HOST_SELECTION_STORAGE_VERSION = "2";

export type StoredServiceTier = "" | ServiceTier;
export type StoredReasoningLevel = "" | ReasoningLevel;
export type StoredPermissionMode = "" | PermissionMode;

type StringSelectionSetter = (value: string) => void;
type StoredServiceTierSetter = (value: StoredServiceTier) => void;
type StoredReasoningLevelSetter = (value: StoredReasoningLevel) => void;
type StoredPermissionModeSetter = (value: StoredPermissionMode) => void;

export interface PersistedStringSelectionField {
  setValue: StringSelectionSetter;
  value: string;
}

export interface PersistedServiceTierSelectionField {
  setValue: StoredServiceTierSetter;
  value: StoredServiceTier;
}

export interface PersistedReasoningLevelSelectionField {
  setValue: StoredReasoningLevelSetter;
  value: StoredReasoningLevel;
}

export interface PersistedPermissionModeSelectionField {
  setValue: StoredPermissionModeSetter;
  value: StoredPermissionMode;
}

export interface PromptBoxProviderModelReasoningPreference {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
}

function isReasoningLevel(value: string): value is ReasoningLevel {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "ultracode" ||
    value === "max" ||
    value === "ultra"
  );
}

function isPermissionMode(value: string): value is PermissionMode {
  return value === "accept-edits" || value === "auto" || value === "full";
}

function isServiceTier(value: string): value is ServiceTier {
  return value === "fast" || value === "default";
}

function isStoredServiceTier(value: string): value is StoredServiceTier {
  return value === "" || isServiceTier(value);
}

function isStoredReasoningLevel(value: string): value is StoredReasoningLevel {
  return value === "" || isReasoningLevel(value);
}

function isStoredPermissionMode(value: string): value is StoredPermissionMode {
  return value === "" || isPermissionMode(value);
}

const emptyModelAtom = atom("");
const emptyReasoningLevelAtom = atom<StoredReasoningLevel>("");

function normalizeHostId(hostId?: string | null): string | null {
  const normalized = hostId?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function getHostSelectionStorageKey(
  storageKey: string,
  hostId: string,
  providerId?: string,
): string {
  const scope =
    providerId === undefined ? [hostId.trim()] : [hostId.trim(), providerId];
  return `${storageKey}-${encodeURIComponent(JSON.stringify(scope))}-${HOST_SELECTION_STORAGE_VERSION}`;
}

function getProviderSelectionStorageKey(
  storageKey: string,
  providerId: string,
): string {
  return `${storageKey}-${encodeURIComponent(providerId.trim())}-${PROVIDER_SELECTION_STORAGE_VERSION}`;
}

function getLegacyProviderSelection(
  providerId: string,
  storageKey: string,
  includeProviderScopedValue = false,
): string | null {
  if (typeof window === "undefined") return null;
  if (includeProviderScopedValue) {
    const value = window.localStorage.getItem(
      getProviderSelectionStorageKey(storageKey, providerId),
    );
    if (value !== null) return value;
  }
  if (window.localStorage.getItem(PROVIDER_STORAGE_KEY) !== providerId) {
    return null;
  }
  return window.localStorage.getItem(storageKey);
}

function createHostProviderStorage() {
  return createLocalStorageSyncStorage<string>({
    parse: (storedValue, initialValue) =>
      storedValue ??
      (typeof window === "undefined"
        ? null
        : window.localStorage.getItem(PROVIDER_STORAGE_KEY)) ??
      initialValue,
    serialize: (value) => value,
  });
}

function createProviderModelStorage(
  providerId: string,
  includeProviderScopedValue = false,
) {
  return createLocalStorageSyncStorage<string>({
    parse: (storedValue, initialValue) =>
      storedValue ??
      getLegacyProviderSelection(
        providerId,
        MODEL_STORAGE_KEY,
        includeProviderScopedValue,
      ) ??
      initialValue,
    serialize: (value) => value,
  });
}

function createProviderReasoningStorage(
  providerId: string,
  includeProviderScopedValue = false,
) {
  return createLocalStorageSyncStorage<StoredReasoningLevel>({
    parse: (storedValue, initialValue) => {
      const value =
        storedValue ??
        getLegacyProviderSelection(
          providerId,
          REASONING_STORAGE_KEY,
          includeProviderScopedValue,
        );
      return value !== null && isStoredReasoningLevel(value)
        ? value
        : initialValue;
    },
    serialize: (value) => value,
  });
}

const providerIdAtomFamily = atomFamily((hostId: string | null) =>
  atomWithStorage<string>(
    hostId
      ? getHostSelectionStorageKey(PROVIDER_STORAGE_KEY, hostId)
      : PROVIDER_STORAGE_KEY,
    "",
    hostId ? createHostProviderStorage() : rawStringLocalStorage,
    { getOnInit: true },
  ),
);

type HostProviderScope = readonly [hostId: string | null, providerId: string];

function isSameHostProviderScope(
  left: HostProviderScope,
  right: HostProviderScope,
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

const modelAtomFamily = atomFamily(
  ([hostId, providerId]: HostProviderScope) =>
    atomWithStorage<string>(
      hostId
        ? getHostSelectionStorageKey(MODEL_STORAGE_KEY, hostId, providerId)
        : getProviderSelectionStorageKey(MODEL_STORAGE_KEY, providerId),
      "",
      createProviderModelStorage(providerId, hostId !== null),
      { getOnInit: true },
    ),
  isSameHostProviderScope,
);

const reasoningLevelAtomFamily = atomFamily(
  ([hostId, providerId]: HostProviderScope) =>
    atomWithStorage<StoredReasoningLevel>(
      hostId
        ? getHostSelectionStorageKey(REASONING_STORAGE_KEY, hostId, providerId)
        : getProviderSelectionStorageKey(REASONING_STORAGE_KEY, providerId),
      "",
      createProviderReasoningStorage(providerId, hostId !== null),
      { getOnInit: true },
    ),
  isSameHostProviderScope,
);
const serviceTierAtom = atomWithStorage<StoredServiceTier>(
  SERVICE_TIER_STORAGE_KEY,
  "",
  createLocalStorageEnumStorage(isStoredServiceTier),
  { getOnInit: true },
);
// Legacy preference migration: "workspace-write" maps onto the same workspace
// sandbox as "accept-edits", so the user's stored intent carries forward.
// Legacy "readonly" (and any other unknown value) is dropped rather than
// reinterpreted — localStorage is untrusted, and a read-only preference must
// never silently become a writable mode.
const permissionModePreferenceStorage =
  createLocalStorageSyncStorage<StoredPermissionMode>({
    parse: (storedValue, initialValue) => {
      if (storedValue === "workspace-write") {
        return "accept-edits";
      }
      return storedValue !== null && isStoredPermissionMode(storedValue)
        ? storedValue
        : initialValue;
    },
    serialize: (value) => value,
  });

const permissionModeAtom = atomWithStorage<StoredPermissionMode>(
  PERMISSION_MODE_STORAGE_KEY,
  "",
  permissionModePreferenceStorage,
  { getOnInit: true },
);
const environmentSelectionAtom = atomWithStorage<string>(
  ENVIRONMENT_STORAGE_KEY,
  "",
  rawStringLocalStorage,
  { getOnInit: true },
);
const projectEnvironmentSelectionAtomFamily = atomFamily((projectId: string) =>
  atomWithStorage<string>(
    getProjectScopedStorageKey(ENVIRONMENT_STORAGE_KEY, projectId),
    "",
    rawStringLocalStorage,
    { getOnInit: true },
  ),
);

export function usePromptBoxProviderPreference(
  hostId?: string | null,
): PersistedStringSelectionField {
  const normalizedHostId = normalizeHostId(hostId);
  const [value, setAtomValue] = useAtom(providerIdAtomFamily(normalizedHostId));
  const setValue = useCallback(
    (nextValue: string) => {
      if (
        normalizedHostId === null &&
        nextValue !== value &&
        typeof window !== "undefined"
      ) {
        // Once the provider changes, the legacy unscoped values no longer have
        // a trustworthy owner. The caller saves the current pair under its
        // provider-scoped keys before changing this value.
        window.localStorage.removeItem(MODEL_STORAGE_KEY);
        window.localStorage.removeItem(REASONING_STORAGE_KEY);
      }
      setAtomValue(nextValue);
    },
    [normalizedHostId, setAtomValue, value],
  );
  return { setValue, value };
}

export function usePromptBoxModelPreference(
  providerId: string,
  hostId?: string | null,
): PersistedStringSelectionField {
  const normalizedHostId = normalizeHostId(hostId);
  const selectionAtom = !providerId
    ? emptyModelAtom
    : modelAtomFamily([normalizedHostId, providerId]);
  const [value, setAtomValue] = useAtom(selectionAtom);
  const setValue = useCallback(
    (nextValue: string) => {
      setAtomValue(nextValue);
    },
    [setAtomValue],
  );
  return { setValue, value };
}

export function usePromptBoxServiceTierPreference(): PersistedServiceTierSelectionField {
  const [value, setAtomValue] = useAtom(serviceTierAtom);
  const setValue = useCallback(
    (nextValue: StoredServiceTier) => {
      setAtomValue(nextValue);
    },
    [setAtomValue],
  );
  return { setValue, value };
}

export function usePromptBoxReasoningLevelPreference(
  providerId: string,
  hostId?: string | null,
): PersistedReasoningLevelSelectionField {
  const normalizedHostId = normalizeHostId(hostId);
  const selectionAtom = !providerId
    ? emptyReasoningLevelAtom
    : reasoningLevelAtomFamily([normalizedHostId, providerId]);
  const [value, setAtomValue] = useAtom(selectionAtom);
  const setValue = useCallback(
    (nextValue: StoredReasoningLevel) => {
      setAtomValue(nextValue);
    },
    [setAtomValue],
  );
  return { setValue, value };
}

export function useSetPromptBoxProviderModelReasoningPreference(
  hostId?: string | null,
): (preference: PromptBoxProviderModelReasoningPreference) => void {
  const store = useStore();
  const normalizedHostId = normalizeHostId(hostId);
  return useCallback(
    ({ providerId, model, reasoningLevel }) => {
      if (providerId.length === 0) return;
      const scope: HostProviderScope = [normalizedHostId, providerId];
      store.set(modelAtomFamily(scope), model);
      store.set(reasoningLevelAtomFamily(scope), reasoningLevel);
    },
    [normalizedHostId, store],
  );
}

export function usePromptBoxPermissionModePreference(): PersistedPermissionModeSelectionField {
  const [value, setAtomValue] = useAtom(permissionModeAtom);
  const setValue = useCallback(
    (nextValue: StoredPermissionMode) => {
      setAtomValue(nextValue);
    },
    [setAtomValue],
  );
  return { setValue, value };
}

export function usePromptBoxEnvironmentPreference(
  projectId?: string | null,
): PersistedStringSelectionField {
  const normalizedProjectId = projectId?.trim();
  const atom =
    normalizedProjectId && normalizedProjectId.length > 0
      ? projectEnvironmentSelectionAtomFamily(normalizedProjectId)
      : environmentSelectionAtom;
  const [value, setAtomValue] = useAtom(atom);
  const setValue = useCallback(
    (nextValue: string) => {
      setAtomValue(nextValue);
    },
    [setAtomValue],
  );
  return { setValue, value };
}
