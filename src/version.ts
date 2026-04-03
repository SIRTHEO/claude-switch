import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
export const VERSION: string = (JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
