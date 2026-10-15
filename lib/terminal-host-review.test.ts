/** Regression coverage for no-op navigation showing or extending the scrollbar. */
import { expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

async function session(body: (term: Terminal, opacity: (advance?: number) => number) => void) {
  const term = await createIsolatedTerminal({ cols: 40, rows: 5 });
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    term.open(container);
    const host = term as unknown as {
      cancelRenderLoop(): void;
      scrollbar: { clock: () => number; getOpacity(): number };
    };
    host.cancelRenderLoop();
    let time = 0;
    host.scrollbar.clock = () => time;
    body(term, (advance = 0) => {
      time += advance;
      return host.scrollbar.getOpacity();
    });
  } finally {
    term.dispose();
    container.remove();
  }
}

const history = (term: Terminal) => term.write('line\r\n'.repeat(50));
const bottomActions: Array<[string, (term: Terminal) => void]> = [
  ['typing', (term) => term.input('a', true)],
  ['paste', (term) => term.paste('a')],
  ['scrollToBottom', (term) => term.scrollToBottom()],
  ['scrollToLine', (term) => term.scrollToLine(0)],
  ['scrollLines', (term) => term.scrollLines(0)],
  ['scrollPages', (term) => term.scrollPages(1)],
];
for (const [name, action] of bottomActions) {
  test(`${name} at the bottom does not reveal the scrollbar`, () =>
    session((term, opacity) => {
      history(term);
      expect(term.wasmTerm!.getScrollState().following).toBe(true);
      const scrolls: number[] = [];
      term.onScroll((offset) => scrolls.push(offset));
      action(term);
      expect(opacity(150)).toBe(0);
      expect(scrolls).toEqual([]);
    }));
}

for (const [name, action] of [
  ['scrollToTop', (term: Terminal) => term.scrollToTop()],
  ['scrollToLine', (term: Terminal) => term.scrollToLine(term.getScrollbackLength())],
  ['scrollLines', (term: Terminal) => term.scrollLines(-1)],
] as const) {
  test(`${name} at the top does not restart an expired scrollbar`, () =>
    session((term, opacity) => {
      history(term);
      term.scrollToTop();
      expect(opacity(150)).toBeGreaterThan(0); // Real navigation still reveals it.
      expect(opacity(2000)).toBe(0);
      action(term);
      expect(opacity(150)).toBe(0);
    }));
}

test('assigning viewportY is silent even across writes; actual history growth still notifies', () =>
  session((term, opacity) => {
    history(term);
    const scrolls: number[] = [];
    term.onScroll((offset) => scrolls.push(offset));
    term.viewportY = 7;
    term.write('X'); // Flushes host effects and polls the native viewport.
    expect(scrolls).toEqual([]);
    expect(opacity(150)).toBe(0);
    term.write('\r\n');
    expect(scrolls).toEqual([8]);
  }));

test('no-op input does not extend an existing scrollbar hide deadline', () =>
  session((term, opacity) => {
    history(term);
    term.scrollToTop();
    term.scrollToBottom();
    expect(opacity(1000)).toBe(1);
    term.input('a', true);
    expect(opacity(800)).toBe(0);
  }));

test('input with empty history does not arm scrollbar visibility for later output', () =>
  session((term, opacity) => {
    term.input('a', true);
    term.scrollToTop();
    history(term);
    expect(opacity(150)).toBe(0);
  }));

test('follow-on-input still changes native following at a pinned last row without showing an overlay', () =>
  session((term, opacity) => {
    // Native top on an empty history is pinned, not following, despite offset 0.
    term.wasmTerm!.scrollViewport({ kind: 'top' });
    expect(term.wasmTerm!.getScrollState().following).toBe(false);
    term.input('a', true);
    expect(term.wasmTerm!.getScrollState().following).toBe(true);
    expect(opacity(150)).toBe(0);
  }));
