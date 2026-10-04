import { context } from 'esbuild';
const options = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true };
const builds = await Promise.all([
  context({ ...options, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }),
  context({ ...options, entryPoints: ['test/extension/index.ts'], outfile: 'dist/test/extension/index.js' }),
]);
if (process.argv.includes('--watch')) await Promise.all(builds.map(build => build.watch()));
else { await Promise.all(builds.map(build => build.rebuild())); await Promise.all(builds.map(build => build.dispose())); }
