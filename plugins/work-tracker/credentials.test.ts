import { access, readFile, stat } from 'node:fs/promises';
import { writeSecretFile } from '@bb/secret-storage';
import { createFakePluginHost } from '@bb/plugin-sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectCredentialVault } from './credentials.js';
import { jiraBaseUrlSchema, secretMutationSchema } from './contract.js';

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

function setup() {
  const host = createFakePluginHost({ pluginId: 'work-tracker-vault-test' });
  hosts.push(host);
  return { host, vault: createProjectCredentialVault(host.bb) };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.harness.dispose()));
});

describe('project credential vault', () => {
  it('rejects multiline credentials and noncanonical Jira origins', () => {
    expect(
      secretMutationSchema.safeParse({
        operation: 'set',
        value: 'first-line\nsecond-line'
      }).success
    ).toBe(false);
    expect(
      jiraBaseUrlSchema.safeParse('https://bb.atlassian.net:8443').success
    ).toBe(false);
    expect(
      jiraBaseUrlSchema.safeParse('https://bb.atlassian.net').success
    ).toBe(true);
  });

  it('isolates projects in hashed owner-only files and trims at the boundary', async () => {
    const { vault } = setup();
    await vault.mutate('proj_alpha', 'linear', {
      operation: 'set',
      value: '  alpha-value  '
    });
    await vault.mutate('proj_beta', 'linear', {
      operation: 'set',
      value: 'beta-value'
    });

    expect(await vault.read('proj_alpha', 'linear')).toBe('alpha-value');
    expect(await vault.read('proj_beta', 'linear')).toBe('beta-value');
    const alphaPath = vault.credentialPath('proj_alpha', 'linear');
    const betaPath = vault.credentialPath('proj_beta', 'linear');
    expect(alphaPath).not.toBe(betaPath);
    expect(alphaPath).not.toContain('proj_alpha');
    expect((await stat(alphaPath)).mode & 0o777).toBe(0o600);

    await vault.mutate('proj_alpha', 'linear', { operation: 'clear' });
    expect(await vault.configured('proj_alpha', 'linear')).toBe(false);
    expect(await vault.configured('proj_beta', 'linear')).toBe(true);
  });

  it('does not guess an owner for an ambiguous legacy credential', async () => {
    const { vault } = setup();
    const legacyPath = vault.legacyCredentialPath('linear');
    await writeSecretFile(legacyPath, 'legacy-value');

    await expect(
      vault.migrateLegacy('linear', ['proj_alpha', 'proj_beta'])
    ).resolves.toEqual({ outcome: 'ambiguous-projects', projectId: null });
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('legacy-value');
    expect(await vault.configured('proj_alpha', 'linear')).toBe(false);
    expect(await vault.configured('proj_beta', 'linear')).toBe(false);
  });

  it('writes and verifies the sole destination before removing the legacy file', async () => {
    const { vault } = setup();
    const legacyPath = vault.legacyCredentialPath('jira');
    await writeSecretFile(legacyPath, 'legacy-jira-value');

    await expect(vault.migrateLegacy('jira', ['proj_alpha'])).resolves.toEqual({
      outcome: 'migrated',
      projectId: 'proj_alpha'
    });
    expect(await vault.read('proj_alpha', 'jira')).toBe('legacy-jira-value');
    await expect(access(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(vault.migrateLegacy('jira', [])).resolves.toEqual({
      outcome: 'no-legacy-credential',
      projectId: null
    });
  });

  it('finishes an interrupted delete without overwriting a conflicting destination', async () => {
    const first = setup().vault;
    await writeSecretFile(
      first.legacyCredentialPath('linear'),
      'matching-value'
    );
    await first.mutate('proj_alpha', 'linear', {
      operation: 'set',
      value: 'matching-value'
    });
    await expect(
      first.migrateLegacy('linear', ['proj_alpha'])
    ).resolves.toEqual({
      outcome: 'already-migrated',
      projectId: 'proj_alpha'
    });
    await expect(
      access(first.legacyCredentialPath('linear'))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const second = setup().vault;
    await writeSecretFile(
      second.legacyCredentialPath('linear'),
      'legacy-value'
    );
    await second.mutate('proj_alpha', 'linear', {
      operation: 'set',
      value: 'different-value'
    });
    await expect(
      second.migrateLegacy('linear', ['proj_alpha'])
    ).resolves.toEqual({
      outcome: 'destination-conflict',
      projectId: 'proj_alpha'
    });
    expect(await second.read('proj_alpha', 'linear')).toBe('different-value');
    await expect(
      readFile(second.legacyCredentialPath('linear'), 'utf8')
    ).resolves.toBe('legacy-value');
  });
});
