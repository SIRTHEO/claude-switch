// Worker for the lock concurrency stress test. Forked (NOT a thread) so each
// instance has a distinct OS pid — required for the stale-lock reclaim logic
// to behave as it does across real `claude switch` invocations.
//
// Each worker loops: acquire the lock, assert it is the sole occupant of a
// witness file, hold briefly, release. If the lock ever lets two workers into
// the critical section at once, the witness check trips and we report it.
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from '../../src/lock.js';

const dir = process.argv[2]!;
const iters = parseInt(process.argv[3] ?? '40', 10);
const witness = path.join(dir, '.witness');
const me = String(process.pid);

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let doubles = 0;
let acquired = 0;

for (let i = 0; i < iters; i++) {
  let release: (() => void) | null = null;
  try {
    release = acquireLock(dir, 4000);
  } catch {
    // Timeout under heavy contention is acceptable — it is NOT a correctness
    // violation, just back-pressure. Keep looping.
    continue;
  }
  acquired++;
  try {
    // On entry the witness must be empty: the previous holder clears it
    // before releasing. A non-empty value belonging to someone else means
    // two workers are in the critical section simultaneously.
    let cur = '';
    try { cur = fs.readFileSync(witness, 'utf-8'); } catch { /* absent */ }
    if (cur && cur !== me) doubles++;

    fs.writeFileSync(witness, me);
    sleepMs(1); // widen the critical section so any overlap is observable
    let after = '';
    try { after = fs.readFileSync(witness, 'utf-8'); } catch { /* absent */ }
    if (after !== me) doubles++; // someone overwrote us while we "held" it

    fs.writeFileSync(witness, '');
  } finally {
    release();
  }
}

process.send?.({ doubles, acquired });
