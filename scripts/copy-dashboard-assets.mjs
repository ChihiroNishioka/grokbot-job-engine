import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const source = fileURLToPath(new URL('../src/dashboard/public/', import.meta.url));
const destination = resolve('dist/dashboard/public');
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
