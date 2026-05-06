// test/ui/components.test.tsx
// Smoke tests for the pure visual primitives still in production: the
// usageGlyph mapper and the ProgressBar. Stateful screens (home, settings,
// manage-account, profiles, setup-wizard) are not covered here — they hit
// Keychain or spawn subprocesses, and the orchestrator + screens live
// behind manual smoke testing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';

import { ProgressBar } from '../../src/ui/components/progress-bar.js';
import { usageGlyph } from '../../src/ui/components/usage-glyph.js';

describe('usageGlyph', () => {
  it('returns gray ○ for undefined usage', () => {
    const g = usageGlyph(undefined);
    assert.equal(g.glyph, '○');
    assert.equal(g.color, 'gray');
  });

  it('returns red ○ at 95% (rate-limit zone)', () => {
    assert.equal(usageGlyph(95).color, 'red');
    assert.equal(usageGlyph(100).color, 'red');
  });

  it('returns orange ◑ between 85 and 95', () => {
    assert.equal(usageGlyph(85).glyph, '◑');
    assert.equal(usageGlyph(90).glyph, '◑');
  });

  it('returns yellow ◐ between 50 and 85', () => {
    assert.equal(usageGlyph(50).glyph, '◐');
    assert.equal(usageGlyph(50).color, 'yellow');
    assert.equal(usageGlyph(84).glyph, '◐');
  });

  it('returns green ● below 50', () => {
    assert.equal(usageGlyph(0).color, 'green');
    assert.equal(usageGlyph(49).color, 'green');
  });
});

describe('ProgressBar', () => {
  it('renders dashes for undefined percentage', () => {
    const { lastFrame } = render(<ProgressBar pct={undefined} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /─/);
    assert.doesNotMatch(frame, /█/);
  });

  it('renders proportional fill at 50%', () => {
    const { lastFrame } = render(<ProgressBar pct={50} width={10} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /█{5}/);
    assert.match(frame, /░{5}/);
  });

  it('clamps width to the supplied value', () => {
    const { lastFrame } = render(<ProgressBar pct={100} width={4} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /█{4}/);
  });
});
