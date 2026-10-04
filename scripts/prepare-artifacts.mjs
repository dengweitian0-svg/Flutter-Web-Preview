import { mkdir } from 'node:fs/promises';
await Promise.all(['artifacts', '.cache'].map(directory => mkdir(directory, { recursive: true })));
