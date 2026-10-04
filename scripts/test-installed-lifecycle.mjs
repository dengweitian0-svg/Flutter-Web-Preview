import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { DevTools } = createRequire(import.meta.url)('../dist/test/devTools.js');
const executable = process.env.VSCODE_EXECUTABLE;
if (!executable) throw new Error('Set VSCODE_EXECUTABLE to Code.exe. Install the VSIX into .cache/vsix-extensions first.');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 120000) {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > timeout) throw new Error('Installed lifecycle test timed out.'); await wait(150); }
}
async function portFree() {
  try { await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(7357, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve())); }); return true; } catch { return false; }
}
assert(await portFree(), 'The fixture port must be free before this test.');
const profile = path.resolve(`.cache/installed-lifecycle-${randomUUID()}`);
await mkdir(profile, { recursive: true });
const child = spawn(executable, [path.resolve('test/fixtures/flutter_app'), '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates', '--remote-debugging-port=9334', '--remote-debugging-address=127.0.0.1', '--user-data-dir', profile, '--extensions-dir', path.resolve('.cache/vsix-extensions')], { windowsHide: true });
let output = ''; child.stdout.on('data', text => { output += String(text); }); child.stderr.on('data', text => { output += String(text); });
const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
let client;
const checks = [];
async function connect() {
  await until(async () => { try { client = await DevTools.connect('vscode-file://', 9334); return true; } catch { return false; } }, 30000);
  await until(async () => await client.evaluate("!!document.querySelector('.monaco-workbench .part.statusbar')"), 30000);
  await client.request('Page.bringToFront');
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await client.request('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
  await client.request('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}
async function palette(label) {
  console.log(`Invoking ${label}`);
  await key('F1', 'F1', 112);
  await until(async () => await client.evaluate("!!document.querySelector('.quick-input-widget input')?.offsetParent"), 10000);
  await client.evaluate("(()=>{const input=document.querySelector('.quick-input-widget input');input.focus();input.setSelectionRange(0,input.value.length)})()");
  await client.request('Input.insertText', { text: `>${label}` });
  try { await until(async () => {
    const text = await client.evaluate("document.querySelector('.quick-input-widget .monaco-list-row.focused')?.textContent || ''");
    return String(text).includes(label.split(': ').at(-1));
  }, 10000); } catch (error) {
    const diagnostic = await client.evaluate("({input:document.querySelector('.quick-input-widget input')?.value,rows:[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(e=>e.textContent)})");
    await writeFile(path.resolve('artifacts/palette-failure.json'), JSON.stringify(diagnostic, null, 2)); throw error;
  }
  await key('Enter', 'Enter', 13);
}
async function state() { return String(await client.evaluate("[...document.querySelectorAll('.statusbar-item')].map(e=>e.textContent).join(' ' )")); }
try {
  await connect();
  await palette('Flutter Web Preview: Run Web Preview');
  await until(async () => (await state()).includes('Web Preview: running'));
  assert(!await portFree()); checks.push('installed extension runs without a development override');
  await palette('Developer: Reload Window');
  client.close(); client = undefined;
  await connect();
  await until(portFree, 15000); checks.push('Reload Window releases the Flutter port');
  await palette('Flutter Web Preview: Run Web Preview');
  await until(async () => (await state()).includes('Web Preview: running'));
  assert(!await portFree());
  await palette('Extensions: Disable All Installed Extensions');
  // VS Code applies active-extension disablement when its requested reload completes.
  await palette('Developer: Reload Window');
  client.close(); client = undefined; await connect();
  await until(portFree, 15000);
  await until(async () => !(await state()).includes('Web Preview:'), 15000);
  checks.push('disabling the installed extension and applying reload stops Flutter');
  console.log(`INSTALLED LIFECYCLE PASSED: ${checks.join('; ')}`);
} finally {
  if (client) {
    try { await palette('File: Close Window'); } catch { /* the UI channel closes with the window */ }
    client.close();
  }
  await Promise.race([exit, wait(10000)]);
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); killer.on('error', reject); killer.on('exit', code => code === 0 ? resolve() : reject(new Error('Cannot close owned lifecycle test process.'))); });
  }
  await writeFile(path.resolve('artifacts/installed-lifecycle.json'), JSON.stringify({ checks }, null, 2));
  await writeFile(path.resolve('artifacts/installed-lifecycle.log'), output);
}
