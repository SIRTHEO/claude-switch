#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runSetup } from '../src/setup.js';

try {
  // Pass cli.js path so the resolver correctly excludes the installed wrapper
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
  runSetup(cliPath);
} catch (e) {
  console.log('claude-switch: setup warning:', (e as Error).message);
}
