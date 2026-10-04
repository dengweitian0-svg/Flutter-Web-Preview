import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
const size = 256; const pixels = Buffer.alloc(size * size * 4);
function rect(x, y, width, height, color) {
  for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) pixels.set(color, (row * size + column) * 4);
}
rect(0, 0, 256, 256, [8, 40, 54, 255]);
rect(24, 40, 208, 176, [239, 249, 250, 255]);
rect(24, 40, 208, 28, [8, 127, 140, 255]);
for (const x of [36, 48, 60]) rect(x, 50, 6, 6, [255, 255, 255, 255]);
rect(124, 80, 4, 124, [8, 127, 140, 255]);
for (let y = 102; y < 150; y++) {
  const offset = Math.abs(y - 126);
  rect(47 + offset, y, 7, 1, [8, 127, 140, 255]);
  rect(100 - offset, y, 7, 1, [8, 127, 140, 255]);
}
for (let y = 105; y < 164; y++) rect(155, y, Math.max(1, 36 - Math.abs(y - 134)), 1, [8, 127, 140, 255]);
function crc(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let row = 0; row < size; row++) pixels.copy(scanlines, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
await mkdir('assets', { recursive: true });
await writeFile('assets/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]));
