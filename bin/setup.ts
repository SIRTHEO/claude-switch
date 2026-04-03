#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runSetup } from '../src/setup.js';

try {
  runSetup(fileURLToPath(import.meta.url));
} catch (e) {
  console.log('claude-switch: setup warning:', (e as Error).message);
}
