/** Regression cases recovered from the independent integration review. */
import { expect, test } from 'bun:test';
import { Ghostty } from './ghostty';
import { Terminal } from './terminal';

type Session = {
  term: Terminal;
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  data: string[];
};
async function session(body: (s: Session) => void | Promise<void>): Promise<void> {
  const term = new Terminal({ ghostty: await Ghostty.load(), cols: 40, rows: 10 });
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    term.open(container);
    const data: string[] = [];
    term.onData((text) => data.push(text));
    await body({ term, container, canvas: container.querySelector('canvas')!, data });
  } finally {
    term.dispose();
    container.remove();
  }
}

function key(target: HTMLElement, type: string, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function wheel(canvas: HTMLCanvasElement, deltaY = -99): void {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  // Happy DOM's WheelEvent omits inherited pointer fields.
  for (const [name, value] of Object.entries({ clientX: 10, clientY: 10, buttons: 0 })) {
    Object.defineProperty(event, name, { value });
  }
  canvas.dispatchEvent(event);
}

test('review: read-only alternate-screen wheel sends no terminal input', async () => {
  await session(({ term, canvas, data }) => {
    term.write('\x1b[?1049h');
    term.options.disableStdin = true;
    wheel(canvas);
    expect(data).toEqual([]);
    term.options.disableStdin = false;
    wheel(canvas);
    expect(data).toEqual(['\x1b[A', '\x1b[A', '\x1b[A']);
  });
});

test('review: Kitty key release survives internal focus transfers in either direction', async () => {
  for (const textareaFirst of [false, true]) {
    await session(({ term, container, data }) => {
      const textarea = container.querySelector('textarea')!;
      const [from, to] = textareaFirst ? [textarea, container] : [container, textarea];
      from.focus();
      term.write('\x1b[>3u');
      key(from, 'keydown', { key: 'a', code: 'KeyA' });
      to.focus();
      key(to, 'keyup', { key: 'a', code: 'KeyA' });
      expect(data).toEqual(['a', '\x1b[97;1:3u']);
    });
  }
});

test('review: Kitty ownership clears on a real focus loss, window blur and disposal', async () => {
  await session(({ term, container, data }) => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      term.write('\x1b[>3u');
      key(container, 'keydown', { key: 'a', code: 'KeyA' });
      outside.focus();
      container.focus();
      key(container, 'keyup', { key: 'a', code: 'KeyA' });
      expect(data).toEqual(['a']);
      key(container, 'keydown', { key: 'b', code: 'KeyB' });
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      key(container, 'keyup', { key: 'b', code: 'KeyB' });
      expect(data).toEqual(['a', 'b']);
      term.dispose();
      key(container, 'keyup', { key: 'b', code: 'KeyB' });
      expect(data).toEqual(['a', 'b']);
    } finally {
      outside.remove();
    }
  });
});

test('review: report-all mode forwards all modifier identities without clearing local selection', async () => {
  const modifiers = [
    ['ShiftLeft', 'Shift', 'shiftKey', 57441, 2],
    ['ShiftRight', 'Shift', 'shiftKey', 57447, 2],
    ['ControlLeft', 'Control', 'ctrlKey', 57442, 5],
    ['ControlRight', 'Control', 'ctrlKey', 57448, 5],
    ['AltLeft', 'Alt', 'altKey', 57443, 3],
    ['AltRight', 'Alt', 'altKey', 57449, 3],
    ['MetaLeft', 'Meta', 'metaKey', 57444, 9],
    ['MetaRight', 'Meta', 'metaKey', 57450, 9],
  ] as const; // Codepoints: pinned ghostty/src/input/kitty.zig.
  await session(({ term, container, data }) => {
    term.write('hello\x1b[>11u');
    term.select(0, 0, 5);
    for (const [code, name, modifier, point, mods] of modifiers) {
      data.length = 0;
      key(container, 'keydown', { code, key: name, [modifier]: true });
      key(container, 'keyup', { code, key: name, [modifier]: false });
      expect(data).toEqual([`\x1b[${point};${mods}u`, `\x1b[${point};1:3u`]);
      expect(term.getSelection()).toBe('hello');
    }
  });
});

test('review: a key press suppressed by disabled stdin never owns a later Kitty release', async () => {
  await session(({ term, container, data }) => {
    term.write('\x1b[>3u');
    term.options.disableStdin = true;
    key(container, 'keydown', { key: 'a', code: 'KeyA' });
    term.options.disableStdin = false;
    key(container, 'keyup', { key: 'a', code: 'KeyA' });
    expect(data).toEqual([]);
  });
});

test('review: ordinary modifier keys remain browser-owned when native encoding is empty', async () => {
  await session(({ container, data }) => {
    for (const flags of [
      { key: 'Shift', code: 'ShiftLeft', shiftKey: true },
      { key: 'Control', code: 'ControlLeft', ctrlKey: true },
    ]) {
      const event = key(container, 'keydown', flags);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(data).toEqual([]);
  });
});

test('review: cancelling wheel animation settles at its whole-row target', async () => {
  for (const action of ['relative', 'custom', 'tracking'] as const) {
    await session(({ term, canvas }) => {
      for (let i = 0; i < 30; i++) term.write(`line ${i}\r\n`);
      const control = term as unknown as {
        targetViewportY: number;
        scrollAnimationFrame?: number;
        scrollAnimationStartTime?: number;
      };
      // A state reached by the real smoothing loop, frozen at a deterministic point.
      term.viewportY = 2.5;
      control.targetViewportY = 3;
      control.scrollAnimationStartTime = Date.now();
      control.scrollAnimationFrame = requestAnimationFrame(() => {});
      const scrolls: number[] = [];
      term.onScroll((row) => scrolls.push(row));
      if (action === 'relative') term.scrollLines(-1);
      if (action === 'custom') {
        term.attachCustomWheelEventHandler(() => true);
        wheel(canvas);
      }
      if (action === 'tracking') {
        term.wasmTerm!.write('\x1b[?1000h\x1b[?1006h');
        wheel(canvas);
      }
      expect(term.getViewportY()).toBe(action === 'relative' ? 4 : 3);
      expect(control.scrollAnimationFrame).toBeUndefined();
      expect(scrolls).toEqual([action === 'relative' ? 4 : 3]);
    });
  }
});

test('review: resize notifies the host before in-band size reports, including nested writes', async () => {
  await session(({ term, data }) => {
    term.write('\x1b[?2048h');
    data.length = 0;
    const order: string[] = [];
    term.onData((text) => order.push(`data:${text}`));
    term.onResize(() => {
      order.push('resize-first');
      term.write('\x1b[5n');
    });
    term.onResize(() => order.push('resize-last'));
    term.resize(50, 12);
    expect(order.slice(0, 2)).toEqual(['resize-first', 'resize-last']);
    expect(order.slice(2).some((s) => s.includes('[48;12;50;'))).toBe(true);
    expect(data.join('')).toEndWith('\x1b[0n');
  });
});

test('review: resize listeners may dispose or resize again without dispatching stale callbacks', async () => {
  await session(({ term, data }) => {
    term.write('\x1b[?2048h');
    data.length = 0;
    const order: string[] = [];
    term.onData(() => order.push('data'));
    term.onResize(({ cols }) => {
      order.push(`resize:${cols}`);
      if (cols === 50) term.resize(60, 14);
    });
    term.resize(50, 12);
    expect(order.slice(0, 2)).toEqual(['resize:50', 'resize:60']);
    expect([term.cols, term.rows, term.wasmTerm!.cols, term.wasmTerm!.rows]).toEqual([
      60, 14, 60, 14,
    ]);
  });
  await session(({ term, data }) => {
    term.write('\x1b[?2048h');
    data.length = 0;
    term.onResize(() => term.dispose());
    expect(() => term.resize(50, 12)).not.toThrow();
    expect(data).toEqual([]);
  });
});

test('review: a throwing size-reply listener cannot cancel the host resize or its repaint', async () => {
  await session(({ term }) => {
    term.write('\x1b[?2048h');
    const resized: number[][] = [];
    term.onResize(({ cols, rows }) => resized.push([cols, rows]));
    const error = new Error('host data listener');
    term.onData(() => {
      throw error;
    });
    expect(() => term.resize(50, 12)).toThrow(error);
    expect(resized).toEqual([[50, 12]]);
    const metrics = term.renderer!.getMetrics();
    expect(term.renderer!.getCanvas().width).toBe(50 * metrics.width);
    expect([term.cols, term.rows, term.wasmTerm!.cols, term.wasmTerm!.rows]).toEqual([
      50, 12, 50, 12,
    ]);
  });
});
