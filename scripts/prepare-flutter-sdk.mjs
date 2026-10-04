import { mkdir, readFile, writeFile, access, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Pass an exact stable version, for example 3.35.1.');
const base = 'https://storage.googleapis.com/flutter_infra_release/releases';
const archiveBase = process.env.FLUTTER_ARCHIVE_MIRROR === 'cfug' ? 'https://storage.flutter-io.cn/flutter_infra_release/releases' : base;
const releases = await (await fetch(`${base}/releases_windows.json`)).json();
const release = releases.releases.find(item => item.channel === 'stable' && item.version === version);
if (!release) throw new Error(`No official Windows stable archive for ${version}.`);
const root = path.resolve('.cache/flutter-sdk', version); await mkdir(root, { recursive: true });
const archive = path.join(root, 'sdk.zip');
let valid = false;
try { valid = (await readFile(path.join(root, 'archive.sha256'), 'utf8')).trim() === release.sha256; await access(archive); } catch { valid = false; }
if (!valid) {
  const url = `${archiveBase}/${release.archive}`;
  const metadata = await fetch(`${base}/${release.archive}`, { method: 'HEAD' });
  const size = Number(metadata.headers.get('content-length'));
  if (!metadata.ok || !Number.isSafeInteger(size) || size <= 0) throw new Error('Cannot determine SDK archive length.');
  const file = await open(archive, 'w'); let next = 0; let downloaded = 0; let last = 0;
  const block = 4 * 1024 * 1024;
  try {
    await file.truncate(size);
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < size) {
        const start = next; next += block; const end = Math.min(size - 1, start + block - 1);
        let complete = false;
        for (let attempt = 0; attempt < 3 && !complete; attempt++) {
          try {
            const response = await fetch(`${url}?range=${start}-${end}`, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(60000) });
            if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) throw new Error('Server did not honor the SDK byte range.');
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length !== end - start + 1) throw new Error('SDK byte range was truncated.');
            let written = 0;
            while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, start + written); written += result.bytesWritten; }
            complete = true; downloaded += bytes.length;
            if (downloaded - last > 64 * 1024 * 1024) { last = downloaded; console.log(`${version}: ${Math.round(downloaded / 1024 / 1024)} / ${Math.round(size / 1024 / 1024)} MB downloaded`); }
          } catch (error) { if (attempt === 2) throw error; }
        }
      }
    }));
  } finally { await file.close(); }
  const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== release.sha256) throw new Error('SDK archive SHA-256 mismatch.');
  await writeFile(path.join(root, 'archive.sha256'), release.sha256);
} else {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== release.sha256) throw new Error('Cached SDK archive SHA-256 mismatch.');
}
try { await access(path.join(root, 'extraction.complete')); }
catch {
  await new Promise((resolve, reject) => {
    const child = spawn('tar.exe', ['-xf', archive, '-C', root], { windowsHide: true, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`SDK extraction failed (${code})`)));
  });
  await access(path.join(root, 'flutter/bin/cache/dart-sdk/bin/dart.exe'));
  await access(path.join(root, 'flutter/packages/flutter_tools/bin/flutter_tools.dart'));
  await writeFile(path.join(root, 'extraction.complete'), release.sha256);
}
console.log(`Flutter ${version} ready at ${path.join(root, 'flutter')}`);
