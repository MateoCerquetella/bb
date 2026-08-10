import { defineWorkspaceTestConfig } from '../../vitest.shared.js';

export default defineWorkspaceTestConfig({
  test: {
    silent: 'passed-only',
    name: 'bb-plugin-work-tracker',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**']
  }
});
