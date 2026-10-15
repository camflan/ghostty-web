import { expect, test } from 'bun:test';
import type { NativeHostEvent } from '../backends/types';
import type { GhosttyTerminal } from '../ghostty';
import { Termio, type TermioHost } from './termio';

function fixture(overrides: Partial<TermioHost> = {}) {
  const out: string[] = [];
  let effects: NativeHostEvent[] = [];
  let parsing = false;
  let focus = false;
  const terminal = {
    backend: 'libghostty-vt',
    hasFocusEvents: () => focus,
    write(data: string) {
      parsing = true;
      effects.push({ type: 'reply', data });
      if (data === 'enable') focus = true;
      parsing = false;
    },
    takeHostEvents() {
      const events = effects;
      effects = [];
      return events;
    },
  } as unknown as GhosttyTerminal;
  const termio = new Termio(terminal, {
    disposed: () => false,
    inputEnabled: () => true,
    data: (data) => {
      expect(parsing).toBe(false);
      out.push(data);
    },
    bell: () => out.push('bell'),
    title: (title) => out.push(title),
    focusReport: () => out.push('focus'),
    ...overrides,
  });
  return { termio, out, effect: (effect: NativeHostEvent) => effects.push(effect) };
}

test('Termio queues native effects and post-enable focus without reentering parsing', () => {
  const f = fixture();
  f.effect({ type: 'bell' });
  f.effect({ type: 'title', title: 'title' });
  f.termio.processOutput('enable');
  expect(f.out).toEqual(['bell', 'title', 'enable', 'focus']);
});

test('reentrant writes append after previously queued effects', () => {
  const seen: string[] = [];
  const f = fixture({
    data: (data) => {
      seen.push(data);
      if (data === 'one') termio.processOutput('nested');
    },
  });
  const termio = f.termio;
  f.effect({ type: 'reply', data: 'one' });
  termio.processOutput('two');
  expect(seen).toEqual(['one', 'two', 'nested']);
});

test('resize suspension defers replies until host notifications finish', () => {
  const f = fixture();
  f.termio.suspend();
  f.termio.processOutput('size');
  f.termio.flush();
  expect(f.out).toEqual([]);
  f.termio.resume();
  f.termio.flush();
  expect(f.out).toEqual(['size']);
});

test('falsy listener errors preserve later effects for the next dispatch', () => {
  const seen: string[] = [];
  const f = fixture({
    data: (data) => {
      seen.push(data);
      if (data === 'one') throw 0;
    },
  });
  f.effect({ type: 'reply', data: 'one' });
  let threw = false;
  try {
    f.termio.processOutput('two');
  } catch (error) {
    threw = true;
    expect(error).toBe(0);
  }
  expect(threw).toBe(true);
  f.termio.flush();
  expect(seen).toEqual(['one', 'two']);
});

test('reset/clear and disposal stop queued old-state delivery', () => {
  const seen: string[] = [];
  const f = fixture({
    data: (data) => {
      seen.push(data);
      termio.clear();
    },
  });
  const termio = f.termio;
  f.effect({ type: 'reply', data: 'one' });
  termio.processOutput('two');
  expect(seen).toEqual(['one']);
  termio.dispose();
  termio.flush();
  expect(seen).toEqual(['one']);
});
