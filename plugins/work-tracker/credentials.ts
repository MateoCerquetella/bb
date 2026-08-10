import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deleteSecretFile, writeSecretFile } from '@bb/secret-storage';
import type { BbPluginApi } from '@bb/plugin-sdk';
import type { SecretMutation } from './contract.js';

export type CredentialSource = 'linear' | 'jira';

const CREDENTIAL_FILE: Record<CredentialSource, string> = {
  linear: 'linear-api-key',
  jira: 'jira-api-token'
};

const LEGACY_CREDENTIAL_FILE: Record<CredentialSource, string> = {
  linear: 'linearApiKey',
  jira: 'jiraApiToken'
};

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readSecret(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || undefined;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function projectDirectory(projectId: string): string {
  return createHash('sha256').update(projectId).digest('hex');
}

export interface LegacyCredentialMigrationResult {
  outcome:
    | 'no-legacy-credential'
    | 'no-eligible-project'
    | 'ambiguous-projects'
    | 'destination-conflict'
    | 'already-migrated'
    | 'migrated';
  projectId: string | null;
}

export function createProjectCredentialVault(bb: BbPluginApi) {
  const pluginDataDirectory = dirname(bb.storage.database().name);
  const credentialPath = (
    projectId: string,
    source: CredentialSource
  ): string =>
    join(
      pluginDataDirectory,
      'secrets',
      'project-credentials',
      projectDirectory(projectId),
      CREDENTIAL_FILE[source]
    );
  const legacyCredentialPath = (source: CredentialSource): string =>
    join(pluginDataDirectory, 'secrets', LEGACY_CREDENTIAL_FILE[source]);

  return {
    credentialPath,
    legacyCredentialPath,
    read(projectId: string, source: CredentialSource) {
      return readSecret(credentialPath(projectId, source));
    },
    async configured(
      projectId: string,
      source: CredentialSource
    ): Promise<boolean> {
      return (
        (await readSecret(credentialPath(projectId, source))) !== undefined
      );
    },
    async mutate(
      projectId: string,
      source: CredentialSource,
      mutation: SecretMutation
    ): Promise<void> {
      if (mutation.operation === 'keep') return;
      const path = credentialPath(projectId, source);
      if (mutation.operation === 'clear') {
        await deleteSecretFile(path);
        return;
      }
      const value = mutation.value.trim();
      if (!value) throw new Error('Credential cannot be empty');
      await writeSecretFile(path, value);
    },
    async migrateLegacy(
      source: CredentialSource,
      eligibleProjectIds: readonly string[]
    ): Promise<LegacyCredentialMigrationResult> {
      const legacyPath = legacyCredentialPath(source);
      const legacyValue = await readSecret(legacyPath);
      if (!legacyValue) {
        return { outcome: 'no-legacy-credential', projectId: null };
      }
      if (eligibleProjectIds.length === 0) {
        return { outcome: 'no-eligible-project', projectId: null };
      }
      if (eligibleProjectIds.length > 1) {
        return { outcome: 'ambiguous-projects', projectId: null };
      }

      const projectId = eligibleProjectIds[0]!;
      const destination = credentialPath(projectId, source);
      const destinationValue = await readSecret(destination);
      if (destinationValue) {
        if (destinationValue !== legacyValue) {
          return { outcome: 'destination-conflict', projectId };
        }
        await deleteSecretFile(legacyPath);
        return { outcome: 'already-migrated', projectId };
      }

      await writeSecretFile(destination, legacyValue);
      const verification = await readSecret(destination);
      if (verification !== legacyValue) {
        throw new Error('Could not verify migrated credential destination');
      }
      await deleteSecretFile(legacyPath);
      return { outcome: 'migrated', projectId };
    }
  };
}

export type ProjectCredentialVault = ReturnType<
  typeof createProjectCredentialVault
>;
