import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// dist/src/setup/version.js → three levels up to the package root package.json.
const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json');
export const VERSION: string = (JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
