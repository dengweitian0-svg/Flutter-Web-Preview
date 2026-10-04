import { runTests } from '@vscode/test-electron';
import { resolve } from 'node:path';
const executable = process.env.VSCODE_EXECUTABLE;
await runTests({
  ...(executable ? { vscodeExecutablePath: executable } : { version: '1.140.0' }),
  extensionDevelopmentPath: process.cwd(),
  extensionTestsPath: resolve('dist/test/extension/index.js'),
  launchArgs: [resolve('test/fixtures/flutter_app'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir', resolve('.cache/vscode-user'), '--extensions-dir', resolve('.cache/vscode-extensions')],
  extensionTestsEnv: { PREVIEW_TEST_MODE: process.env.PREVIEW_TEST_MODE || 'probe' },
});
