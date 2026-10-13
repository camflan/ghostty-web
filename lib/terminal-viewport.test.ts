/** Row-accurate history painting and local viewport input (real WASM, mock canvas). */
import { expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

type Session = {
  term: Terminal;
  canvas: HTMLCanvasElement;
  wheel(deltaY: number, deltaMode?: number): void;
};
async function session(body: (s: Session) => void | Promise<void>, duration = 0): Promise<void> {
  const term = await createIsolatedTerminal({ cols: 20, rows: 6, smoothScrollDuration: duration });
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    term.open(host);
    const canvas = host.querySelector('canvas')!;
    const wheel = (deltaY: number, deltaMode = 0) =>
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY,
          deltaMode,
          bubbles: true,
          cancelable: true,
        })
      );
    await body({ term, canvas, wheel });
  } finally {
    term.dispose();
    host.remove();
  }
}
const history = (term: Terminal) => {
  for (let n = 0; n < 50; n++) term.write(`line ${n}\r\n`);
};

test('history and shifted active rows draw their own graphemes, including fractional animation offsets', async () => {
  await session(({ term }) => {
    term.write('e\u0301\r\nn\u0303\r\n2\r\n3\r\n4\r\n5\r\n6');
    expect(term.getScrollbackLength()).toBe(1);
    // Happy DOM returns a fresh mock on getContext(); spy on the renderer's
    // retained context, which is where painting actually happens.
    const ctx = (term.renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
    const painted: [string, number][] = [];
    ctx.fillText = (text, _x, y) => {
      painted.push([text, y]);
    };
    const metrics = term.renderer!.getMetrics();
    for (const offset of [1, 1.25]) {
      painted.length = 0;
      term.renderer!.render(term.wasmTerm!, true, offset, term, 0);
      expect(painted).toContainEqual(['e\u0301', metrics.baseline]);
      expect(painted).toContainEqual(['n\u0303', metrics.height + metrics.baseline]);
      expect(painted).not.toContainEqual(['n\u0303', metrics.baseline]);
      expect(painted).toContainEqual(['2', 2 * metrics.height + metrics.baseline]);
    }
  });
});

test('pixel wheel packets accumulate whole rows without fractional viewport targets', async () => {
  await session(({ term, wheel }) => {
    history(term);
    const h = term.renderer!.getMetrics().height;
    for (let n = 0; n < 9; n++) wheel(-h / 10);
    expect(term.getViewportY()).toBe(0);
    wheel(-h / 10);
    expect(term.getViewportY()).toBe(1);
    wheel(-h * 2.25);
    expect(term.getViewportY()).toBe(3);
    wheel(-h * 0.75);
    expect(term.getViewportY()).toBe(4);
  });
});

test('wheel remainder cancels on direction reversal and is discarded at boundaries', async () => {
  await session(({ term, wheel }) => {
    history(term);
    const h = term.renderer!.getMetrics().height;
    wheel(h * 0.75); // already at bottom: no overscroll debt
    wheel(-h);
    expect(term.getViewportY()).toBe(1);
    wheel(-h * 0.75);
    wheel(h * 0.75);
    expect(term.getViewportY()).toBe(1);
    wheel(-h);
    expect(term.getViewportY()).toBe(2);
    term.scrollToTop();
    wheel(-h * 1000.75);
    wheel(h);
    expect(term.getViewportY()).toBe(term.getScrollbackLength() - 1);
  });
});

test('line/page wheel modes, invalid input and programmatic navigation remain predictable', async () => {
  await session(({ term, wheel }) => {
    history(term);
    wheel(-2, 1);
    expect(term.getViewportY()).toBe(2);
    wheel(-1, 2);
    expect(term.getViewportY()).toBe(8);
    wheel(Number.NaN);
    wheel(Number.POSITIVE_INFINITY);
    expect(term.getViewportY()).toBe(8);
    wheel(-term.renderer!.getMetrics().height * 0.75);
    term.scrollToLine(4);
    wheel(-term.renderer!.getMetrics().height * 0.25);
    expect(term.getViewportY()).toBe(4); // old fractional input was reset
  });
});

test('rapid wheel input uses its pending destination and output cancels the old animation', async () => {
  await session(async ({ term, wheel }) => {
    history(term);
    const h = term.renderer!.getMetrics().height;
    wheel(-2 * h);
    wheel(-3 * h);
    const control = term as unknown as { targetViewportY: number; scrollAnimationFrame?: number };
    expect(control.targetViewportY).toBe(5);
    term.write('new output');
    expect(term.getViewportY()).toBe(0);
    expect(control.scrollAnimationFrame).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(term.getViewportY()).toBe(0);
  }, 100);
});

test('scrollbar dragging tracks document motion outside the canvas and stops on blur/up', async () => {
  await session(({ term, canvas }) => {
    history(term);
    const width = 200,
      height = 120;
    const rect = new DOMRect(10, 20, width, height);
    canvas.getBoundingClientRect = () => rect;
    const down = () =>
      canvas.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          clientX: rect.right - 8,
          clientY: rect.bottom - 10,
        })
      );
    const move = (clientY: number) =>
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          buttons: 1,
          clientX: rect.right - 8,
          clientY,
        })
      );
    down();
    move(rect.top - 300);
    expect(term.getViewportY()).toBe(term.getScrollbackLength());
    expect(term.hasSelection()).toBe(false);
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    move(rect.bottom + 300);
    expect(term.getViewportY()).toBe(term.getScrollbackLength());
    term.scrollToBottom();
    down();
    window.dispatchEvent(new Event('blur'));
    move(rect.top - 300);
    expect(term.getViewportY()).toBe(0);
  });
});
