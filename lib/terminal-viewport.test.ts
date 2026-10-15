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

/** Deterministic frames, restored even when an assertion fails. No global test leakage. */
async function withFrames(
  body: (flush: (ticks?: number) => void, time: () => number) => Promise<void>,
  frameMs = 1000 / 60
): Promise<void> {
  const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let clock = performance.now();
  Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  let next = 1;
  const frames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = (callback) => {
    const id = next++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const flush = (ticks = 30) => {
    for (let tick = 0; tick < ticks; tick++) {
      clock += frameMs;
      const batch = [...frames.entries()];
      for (const [id, callback] of batch) {
        if (!frames.delete(id)) continue;
        callback(performance.now());
      }
    }
  };
  try {
    await body(flush, () => clock);
  } finally {
    if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
    else Reflect.deleteProperty(performance, 'now');
    frames.clear();
    globalThis.requestAnimationFrame = request;
    globalThis.cancelAnimationFrame = cancel;
  }
}

for (const action of ['line', 'relative', 'top', 'bottom', 'write'] as const) {
  test(`reentrant ${action} from the first wheel step cannot strand animation ownership`, async () => {
    await withFrames(async (flush) => {
      await session(({ term, wheel }) => {
        history(term);
        let once = true;
        term.onScroll(() => {
          if (!once) return;
          once = false;
          if (action === 'line') term.scrollToLine(10);
          if (action === 'relative') term.scrollLines(-2);
          if (action === 'top') term.scrollToTop();
          if (action === 'bottom') term.scrollToBottom();
          if (action === 'write') term.write('');
        });
        wheel(-5, 1);
        flush();
        const expected =
          action === 'line'
            ? 10
            : action === 'relative'
              ? 7
              : action === 'top'
                ? term.getScrollbackLength()
                : action === 'bottom'
                  ? 0
                  : 5;
        expect(term.viewportY).toBe(expected);
        expect((term as unknown as { targetViewportY: number }).targetViewportY).toBe(expected);
        const delta = action === 'top' ? 3 : -3;
        wheel(delta, 1);
        flush();
        expect(term.viewportY).toBe(expected - delta);
        term.write('x');
        expect(term.viewportY).toBe(expected - delta);
      }, 100);
    });
  });
}

for (const action of ['line', 'write'] as const) {
  test(`reentrant ${action} from a scheduled wheel frame keeps later gestures responsive`, async () => {
    await withFrames(async (flush) => {
      await session(({ term, wheel }) => {
        history(term);
        let calls = 0;
        term.onScroll(() => {
          if (++calls !== 2) return; // first step is synchronous; interrupt the next frame
          if (action === 'line') term.scrollToLine(10);
          else term.write('');
        });
        wheel(-5, 1);
        flush();
        const expected = action === 'line' ? 10 : 5;
        expect(term.viewportY).toBe(expected);
        wheel(-3, 1);
        flush();
        expect(term.viewportY).toBe(expected + 3);
      }, 100);
    });
  });
}

test('a throwing animation observer cannot strand the active owner', async () => {
  await withFrames(async (flush) => {
    await session(({ term, wheel }) => {
      history(term);
      const error = new Error('scroll observer');
      const listener = term.onScroll(() => {
        throw error;
      });
      const control = term as unknown as { smoothScrollTo(target: number): void };
      expect(() => control.smoothScrollTo(5)).toThrow(error);
      listener.dispose();
      flush();
      expect(term.viewportY).toBe(5);
      wheel(-3, 1);
      flush();
      expect(term.viewportY).toBe(8);
    }, 100);
  });
});

test('a completed animation cannot clear a new animation started by its final observer', async () => {
  await withFrames(async (flush) => {
    await session(({ term, wheel }) => {
      history(term);
      let once = true;
      term.onScroll(() => {
        if (!once || term.viewportY !== 5) return;
        once = false;
        wheel(-3, 1);
      });
      wheel(-5, 1);
      flush();
      expect(once).toBe(false);
      expect(term.viewportY).toBe(8);
      wheel(-2, 1);
      flush();
      expect(term.viewportY).toBe(10);
    }, 100);
  });
});

test('a cancelled frame cannot overwrite a replacement started during its observer', async () => {
  await withFrames(async (flush) => {
    await session(({ term, wheel }) => {
      history(term);
      let once = true;
      term.onScroll(() => {
        if (!once) return;
        once = false;
        term.scrollToLine(10);
        wheel(-3, 1);
      });
      wheel(-5, 1);
      flush();
      expect(term.viewportY).toBe(13);
      expect(
        (term as unknown as { scrollAnimationFrame?: number }).scrollAnimationFrame
      ).toBeUndefined();
    }, 100);
  });
});

test('disposal from an animation observer does not schedule another scroll frame', async () => {
  await withFrames(async (flush) => {
    await session(({ term, wheel }) => {
      history(term);
      term.onScroll(() => term.dispose());
      wheel(-5, 1);
      expect(
        (term as unknown as { scrollAnimationFrame?: number }).scrollAnimationFrame
      ).toBeUndefined();
      flush();
      expect(
        (term as unknown as { scrollAnimationFrame?: number }).scrollAnimationFrame
      ).toBeUndefined();
    }, 100);
  });
});

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
    // Output settles the pending reading position instead of jumping to bottom.
    expect(term.getViewportY()).toBe(5);
    expect(control.scrollAnimationFrame).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(term.getViewportY()).toBe(5);
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

for (const frameMs of [1000 / 30, 1000 / 60, 1000 / 144]) {
  test(`smooth scrolling honors elapsed duration at ${Math.round(1000 / frameMs)} Hz`, async () => {
    await withFrames(async (flush, time) => {
      await session(({ term, wheel }) => {
        history(term);
        const elapsed: number[] = [];
        for (const duration of [16.7, 17, 20, 100, 1000, 5000]) {
          term.scrollToBottom();
          term.options.smoothScrollDuration = duration;
          const start = time();
          wheel(-5, 1);
          let frames = 0;
          const ctl = term as unknown as { scrollAnimationStartTime?: number };
          while (
            ctl.scrollAnimationStartTime !== undefined &&
            frames++ < Math.ceil(duration / frameMs) + 2
          )
            flush(1);
          expect(ctl.scrollAnimationStartTime).toBeUndefined();
          expect(term.viewportY).toBe(5);
          const actual = time() - start;
          expect(actual).toBeGreaterThanOrEqual(duration - 0.001);
          expect(actual).toBeLessThanOrEqual(duration + frameMs + 0.001);
          if (elapsed.length) expect(actual).toBeGreaterThanOrEqual(elapsed.at(-1)! - 0.001);
          elapsed.push(actual);
        }
      }, 100);
    }, frameMs);
  });
}

test('a retargeted wheel animation starts from the displayed position and finishes after its duration', async () => {
  await withFrames(async (flush) => {
    await session(({ term, wheel }) => {
      history(term);
      wheel(-5, 1);
      flush(3); // 50 ms into a 100 ms segment
      const before = term.viewportY;
      expect(before).toBeGreaterThan(0);
      expect(before).toBeLessThan(5);
      wheel(-3, 1);
      expect(term.viewportY).toBe(before);
      expect((term as unknown as { targetViewportY: number }).targetViewportY).toBe(8);
      flush(3);
      expect(term.viewportY).toBeGreaterThan(before);
      expect(term.viewportY).toBeLessThan(8);
      flush(4);
      expect(term.viewportY).toBe(8);
    }, 100);
  });
});

test('changing the duration mid-flight does not rewind displayed content', async () => {
  await withFrames(async (flush) => {
    await session(({ term, wheel }) => {
      history(term);
      wheel(-5, 1);
      flush(3);
      const before = term.viewportY;
      term.options.smoothScrollDuration = 1000;
      flush(1);
      expect(term.viewportY).toBeGreaterThanOrEqual(before);
      flush(30);
      expect(term.viewportY).toBeGreaterThan(before);
      expect(term.viewportY).toBeLessThan(5);
      flush(31);
      expect(term.viewportY).toBe(5);
    }, 100);
  });
});
