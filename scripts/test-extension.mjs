import { runTests, TestRunFailedError } from '@vscode/test-electron';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
const executable = process.env.VSCODE_EXECUTABLE;
const shutdownMarker = resolve('artifacts/shutdown-marker.json');
const runId = randomUUID();
const options = {
  ...(executable ? { vscodeExecutablePath: executable } : { version: '1.140.0' }),
  cachePath: resolve('.cache/vscode-test'),
  extensionDevelopmentPath: process.env.PREVIEW_INSTALLED_TEST === '1' ? resolve('.cache/vsix-extensions/wende.flutter-web-preview-0.1.0') : process.cwd(),
  extensionTestsPath: resolve('dist/test/extension/index.js'),
  launchArgs: [resolve('test/fixtures/flutter_app'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--remote-debugging-port=9333', '--remote-debugging-address=127.0.0.1', '--user-data-dir', resolve('.cache/vscode-user'), '--extensions-dir', resolve('.cache/vscode-extensions')],
  extensionTestsEnv: { PREVIEW_TEST_MODE: process.env.PREVIEW_TEST_MODE || 'probe', PREVIEW_SHUTDOWN_MARKER: shutdownMarker, PREVIEW_RUN_ID: runId },
};
try { await runTests(options); }
catch (error) {
  if (!(error instanceof TestRunFailedError) || error.code !== 1 || process.env.PREVIEW_TEST_MODE !== 'shutdown') throw error;
  const marker = JSON.parse(await readFile(shutdownMarker, 'utf8'));
  // Closing the window deliberately interrupts VS Code's test runner (exit 1).
  if (marker.runId !== runId || !marker.closeRequested || marker.error) throw error;
}
if (process.env.PREVIEW_TEST_MODE === 'shutdown') {
  const marker = JSON.parse(await readFile(shutdownMarker, 'utf8'));
  if (marker.runId !== runId || !marker.started || !marker.closeRequested || marker.error) throw new Error('Shutdown test did not close a started preview window.');
  await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(7357, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve())); });
  console.log('CLOSE WINDOW CLEANUP PASSED');
}
