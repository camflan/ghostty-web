/**
 * Bridge tests for the libghostty-vt engine behind the public facades.
 *
 * Every case uses a fresh WASM instance (own linear memory) unless it tests
 * shared-instance behaviour explicitly. The artifact is the root
 * ghostty-vt.wasm, or GHOSTTY_NATIVE_WASM; it must be a libghostty-vt build.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CellFlags, DirtyState, Ghostty, type GhosttyTerminal, KeyEncoderOption } from './ghostty';
import { Key, KeyAction, KittyKeyFlags, Mods } from './types';

const NATIVE_WASM =
  process.env.GHOSTTY_NATIVE_WASM || new URL('../ghostty-vt.wasm', import.meta.url).pathname;

let compiled: WebAssembly.Module | undefined;
function nativeInstance(): WebAssembly.Instance {
  compiled ??= new WebAssembly.Module(readFileSync(NATIVE_WASM));
  return new WebAssembly.Instance(compiled, {});
}

function fresh(): Ghostty {
  return new Ghostty(nativeInstance());
}

function withTerm<T>(
  cols: number,
  rows: number,
  body: (t: GhosttyTerminal, g: Ghostty) => T,
  config?: Parameters<Ghostty['createTerminal']>[2]
): T {
  const g = fresh();
  const t = g.createTerminal(cols, rows, config);
  try {
    return body(t, g);
  } finally {
    t.free();
  }
}

function text(t: GhosttyTerminal, y: number): string {
  return (t.getLine(y) ?? [])
    .map((c, x) =>
      c.width === 0
        ? ''
        : c.grapheme_len
          ? t.getGraphemeString(y, x)
          : c.codepoint
            ? String.fromCodePoint(c.codepoint)
            : ' '
    )
    .join('')
    .trimEnd();
}

function drain(t: GhosttyTerminal): string[] {
  const out: string[] = [];
  for (let r = t.readResponse(); r !== null; r = t.readResponse()) out.push(r);
  return out;
}

const rgb = (c: { [k: string]: number }, p: 'fg' | 'bg') => [c[`${p}_r`], c[`${p}_g`], c[`${p}_b`]];

/** Copy of the native exports with `patch` applied (a new object, so detection reruns). */
function patchedExports(patch: (ex: Record<string, unknown>) => void): WebAssembly.Instance {
  const ex: Record<string, unknown> = { ...nativeInstance().exports };
  patch(ex);
  return { exports: ex } as unknown as WebAssembly.Instance;
}

test('native DECCOLM preserves the host grid and subsequent last-cell rendering', () => {
  for (const cols of [80, 100]) {
    withTerm(cols, 3, (term) => {
      term.write('\x1b[?40h');
      for (const mode of ['h', 'l', 'h']) {
        term.write(`\x1b[?3${mode}`);
        term.update();
        expect(term.getLine(0)?.length).toBe(cols);
        term.write(`\x1b[3;${cols}H#`);
        term.update();
        expect(term.getLine(2)?.[cols - 1].codepoint).toBe(35);
        term.markClean();
      }
      term.resize(72, 4);
      term.write('\x1b[?3h');
      term.write('\x1b[4;72H#');
      term.update();
      expect(term.getLine(3)?.length).toBe(72);
      expect(term.getLine(3)?.[71].codepoint).toBe(35);
    });
  }
});

describe('libghostty-vt detection', () => {
  test('the native artifact is detected on every facade', () => {
    const g = fresh();
    expect(g.backend).toBe('libghostty-vt');
    const t = g.createTerminal(10, 2);
    const k = g.createKeyEncoder();
    expect([t.backend, k.backend]).toEqual(['libghostty-vt', 'libghostty-vt']);
    k.dispose();
    t.free();
  });

  test('an explicit backend requirement is enforced, never substituted', () => {
    expect(new Ghostty(nativeInstance(), { backend: 'libghostty-vt' }).backend).toBe(
      'libghostty-vt'
    );
    expect(() => new Ghostty(nativeInstance(), { backend: 'legacy' })).toThrow(
      "is a 'libghostty-vt' build, but 'legacy' was required"
    );
  });

  test('Ghostty.load(path, options) loads the native artifact', async () => {
    const g = await Ghostty.load(NATIVE_WASM, { backend: 'libghostty-vt' });
    expect(g.backend).toBe('libghostty-vt');
  });

  test('a missing native export throws instead of falling back', () => {
    const instance = patchedExports((ex) => {
      ex.ghostty_render_state_row_cells_get = undefined;
    });
    expect(() => new Ghostty(instance)).toThrow(
      'Malformed libghostty-vt WASM (ghostty_type_json present): missing export ghostty_render_state_row_cells_get'
    );
  });

  test('an export with the wrong arity throws', () => {
    const instance = patchedExports((ex) => {
      ex.ghostty_terminal_resize = (a: number, b: number, c: number) => a + b + c;
    });
    expect(() => new Ghostty(instance)).toThrow(
      'ghostty_terminal_resize takes 3 parameters, expected 5'
    );
  });

  test('a manifest layout mismatch throws', () => {
    const instance = patchedExports((ex) => {
      const memory = ex.memory as WebAssembly.Memory;
      const typeJson = ex.ghostty_type_json as () => number;
      const alloc = ex.ghostty_wasm_alloc as (n: number) => number;
      const original = (() => {
        const bytes = new Uint8Array(memory.buffer);
        const start = typeJson();
        let end = start;
        while (bytes[end]) end++;
        return JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)));
      })();
      original.types.GhosttyCell.bits.style_id.width = 15;
      const encoded = new TextEncoder().encode(`${JSON.stringify(original)}\0`);
      const ptr = alloc(encoded.length);
      new Uint8Array(memory.buffer).set(encoded, ptr);
      ex.ghostty_type_json = () => ptr;
    });
    expect(() => new Ghostty(instance)).toThrow('GhosttyCell.style_id is 15 bits, expected 16');
  });

  test('modules that are neither engine are rejected', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(() => new Ghostty({ exports: { memory } } as unknown as WebAssembly.Instance)).toThrow(
      'Unrecognized Ghostty WASM'
    );
  });

  test('public Key/KeyAction/option values map to native values by name', () => {
    const g = fresh();
    const abi = (
      g as unknown as { impl: { abi: { layout: Record<string, Map<number, unknown>> } } }
    ).impl.abi;
    const nativeKey = (name: string) => {
      const ex = nativeInstance().exports as Record<string, unknown>;
      const memory = ex.memory as WebAssembly.Memory;
      const start = (ex.ghostty_type_json as () => number)();
      const bytes = new Uint8Array(memory.buffer);
      let end = start;
      while (bytes[end]) end++;
      return JSON.parse(new TextDecoder().decode(bytes.subarray(start, end))).types.GhosttyKey
        .values[name];
    };
    const keys = abi.layout.keyMap;
    expect(keys.get(Key.ZERO)).toBe(nativeKey('DIGIT_0'));
    expect(keys.get(Key.UP)).toBe(nativeKey('ARROW_UP'));
    expect(keys.get(Key.KP_PLUS)).toBe(nativeKey('NUMPAD_ADD'));
    // Upstream inserted FN before FN_LOCK; public numbers stay, native ones shift.
    expect(keys.get(Key.FN_LOCK)).toBe(nativeKey('FN_LOCK'));
    expect(keys.get(Key.PASTE)).toBe(nativeKey('PASTE'));
    expect(keys.get(Key.FN_LOCK)).not.toBe(Key.FN_LOCK);
    expect(abi.layout.optionMap.size).toBe(6);
  });
});

describe('libghostty-vt lifecycle', () => {
  test('free is idempotent and later use fails clearly', () => {
    const t = fresh().createTerminal(10, 2);
    t.free();
    t.free();
    expect(() => t.write('x')).toThrow('GhosttyTerminal has been freed');
    expect(() => t.getLine(0)).toThrow('GhosttyTerminal has been freed');
  });

  test('a disposed key encoder fails clearly', () => {
    const k = fresh().createKeyEncoder();
    k.dispose();
    k.dispose();
    expect(() => k.encode({ action: KeyAction.PRESS, key: Key.A, mods: Mods.NONE })).toThrow(
      'KeyEncoder has been disposed'
    );
  });

  test('an empty write is a no-op', () => {
    withTerm(10, 2, (t) => {
      t.update();
      t.markClean();
      t.write('');
      t.write(new Uint8Array(0));
      expect(t.update()).toBe(DirtyState.NONE);
    });
  });

  test('grapheme clustering (2027) is on by default and survives RIS', () => {
    withTerm(10, 2, (t) => {
      expect(t.getMode(2027)).toBe(true);
      t.write('\x1b[?2027l\x1bc');
      expect(t.getMode(2027)).toBe(true);
    });
  });

  test('unknown modes report false', () => {
    withTerm(10, 2, (t) => expect(t.getMode(31999)).toBe(false));
  });

  test('shared instance: terminals are isolated, callbacks reuse one table slot, memory plateaus', () => {
    const g = fresh();
    const table = (g as unknown as { exports: { __indirect_function_table: WebAssembly.Table } })
      .exports.__indirect_function_table;
    const memory = (g as unknown as { exports: { memory: WebAssembly.Memory } }).exports.memory;
    const bystander = g.createTerminal(20, 2);
    bystander.write('bystander\x1b[6n');
    const slots = table.length;
    const cycle = () => {
      const ts = Array.from({ length: 4 }, () => g.createTerminal(80, 24));
      for (const [i, t] of ts.entries()) {
        for (let n = 0; n < 40; n++) t.write(`term ${i} line ${n} ${'x'.repeat(50)}\r\n`);
        t.write('\x1b[6n');
        expect(drain(t)).toEqual(['\x1b[24;1R']);
        t.getLine(0);
      }
      for (const t of ts) t.free();
    };
    for (let i = 0; i < 5; i++) cycle();
    const warm = memory.buffer.byteLength;
    for (let i = 0; i < 20; i++) cycle();
    expect(memory.buffer.byteLength).toBe(warm);
    expect(table.length).toBe(slots);
    expect(text(bystander, 0)).toBe('bystander');
    expect(drain(bystander)).toEqual(['\x1b[1;10R']);
    bystander.free();
  });
});

describe('libghostty-vt render snapshot', () => {
  test('dirty state accumulates until markClean', () => {
    withTerm(10, 4, (t) => {
      expect(t.update()).toBe(DirtyState.FULL);
      // Park the cursor first: rows the cursor leaves are (conservatively) dirty too.
      t.write('\x1b[3;1H');
      t.update();
      t.markClean();
      expect(t.update()).toBe(DirtyState.NONE);
      t.write('x');
      expect(t.update()).toBe(DirtyState.PARTIAL);
      expect([0, 1, 2, 3].map((y) => t.isRowDirty(y))).toEqual([false, false, true, false]);
      t.write('\x1b[1;1Hy');
      // Repeated updates keep earlier dirty rows until markClean.
      expect(t.update()).toBe(DirtyState.PARTIAL);
      expect([0, 2, 3].map((y) => t.isRowDirty(y))).toEqual([true, true, false]);
      t.clearDirty();
      expect(t.isRowDirty(2)).toBe(false);
      t.write('\x1b[?1049h');
      expect(t.needsFullRedraw()).toBe(true);
      t.markClean();
      t.resize(12, 4);
      expect(t.update()).toBe(DirtyState.FULL);
      expect(t.getLine(0)!.length).toBe(12);
    });
  });

  test('getLine returns deep copies', () => {
    withTerm(10, 2, (t) => {
      t.write('ab');
      const line = t.getLine(0)!;
      line[0].codepoint = 0x5a;
      expect(t.getLine(0)![0].codepoint).toBe(0x61);
      expect(t.getLine(2)).toBeNull();
    });
  });

  test('styles, colors and flags', () => {
    withTerm(20, 2, (t) => {
      t.write('\x1b[1;3;4;7mA\x1b[0m\x1b[38;2;1;2;3;48;5;196mB\x1b[0m\x1b[9;2;5;8mC\x1b[0mD');
      const [a, b, c, d] = t.getLine(0)!;
      expect(a.flags).toBe(
        CellFlags.BOLD | CellFlags.ITALIC | CellFlags.UNDERLINE | CellFlags.INVERSE
      );
      expect(rgb(b, 'fg')).toEqual([1, 2, 3]);
      expect(rgb(b, 'bg')).toEqual([255, 0, 0]);
      expect(c.flags).toBe(
        CellFlags.STRIKETHROUGH | CellFlags.FAINT | CellFlags.BLINK | CellFlags.INVISIBLE
      );
      // Defaults match what the legacy engine rendered without a theme.
      expect([...rgb(d, 'fg'), ...rgb(d, 'bg')]).toEqual([204, 204, 204, 0, 0, 0]);
      expect(t.getColors()).toEqual({
        background: { r: 0, g: 0, b: 0 },
        foreground: { r: 204, g: 204, b: 204 },
        cursor: null,
      });
    });
  });

  test('wide characters, spacers and grapheme clusters keep the public shape', () => {
    withTerm(10, 2, (t) => {
      t.write('中e\u0301\u{1F44D}\u{1F3FD}');
      const cells = t.getLine(0)!;
      expect(cells.slice(0, 5).map((c) => [c.codepoint, c.width, c.grapheme_len])).toEqual([
        [0x4e2d, 2, 0],
        [0, 0, 0],
        [0x65, 1, 1],
        [0x1f44d, 2, 1],
        [0, 0, 0],
      ]);
      expect(t.getGrapheme(0, 2)).toEqual([0x65, 0x301]);
      expect(t.getGraphemeString(0, 3)).toBe('\u{1F44D}\u{1F3FD}');
      expect(t.getGrapheme(0, 9)).toEqual([]);
      expect(t.getGrapheme(5, 0)).toBeNull();
      expect(text(t, 0)).toBe('中e\u0301\u{1F44D}\u{1F3FD}');
    });
  });

  test('hyperlinks get stable nonzero ids per URI', () => {
    withTerm(30, 3, (t) => {
      t.write('\x1b]8;;https://a.example\x07aa\x1b]8;;\x07 ');
      t.write('\x1b]8;;https://b.example\x07bb\x1b]8;;\x07 ');
      t.write('\x1b]8;id=x;https://a.example\x07AA\x1b]8;;\x07');
      const ids = t
        .getLine(0)!
        .slice(0, 8)
        .map((c) => c.hyperlink_id);
      expect(ids[0]).toBeGreaterThan(0);
      expect(ids).toEqual([ids[0], ids[0], 0, ids[3], ids[3], 0, ids[0], ids[0]]);
      expect(ids[3]).not.toBe(ids[0]);
      expect(t.getHyperlinkUri(0, 4)).toBe('https://b.example');
      expect(t.getHyperlinkUri(0, 2)).toBeNull();
      expect(t.getHyperlinkUri(9, 0)).toBeNull();
    });
  });

  test('cursor reports active and viewport position', () => {
    withTerm(10, 3, (t) => {
      t.write('\x1b[2;4H\x1b[5 q');
      expect(t.getCursor()).toEqual({
        x: 3,
        y: 1,
        viewportX: 3,
        viewportY: 1,
        visible: true,
        blinking: true,
        style: 'bar',
      });
      t.write('\x1b[?25l');
      expect(t.getCursor().visible).toBe(false);
    });
  });
});

describe('libghostty-vt colors', () => {
  test('a raw all-zero config keeps the documented 0 = default', () => {
    withTerm(
      4,
      1,
      (t) => {
        t.write('\x1b[30mA');
        const [a, blank] = t.getLine(0)!;
        expect([...rgb(blank, 'fg'), ...rgb(blank, 'bg')]).toEqual([204, 204, 204, 0, 0, 0]);
        // Palette black stays Ghostty's default palette entry, not 0.
        expect(rgb(a, 'fg')).not.toEqual([0, 0, 0]);
      },
      { fgColor: 0, bgColor: 0, cursorColor: 0, palette: new Array(16).fill(0) }
    );
  });

  test('colorPresence makes explicit black real', () => {
    withTerm(
      4,
      1,
      (t) => {
        t.write('\x1b[30mA\x1b[31mB');
        const [a, b, blank] = t.getLine(0)!;
        expect(rgb(blank, 'fg')).toEqual([0, 0, 0]);
        expect(rgb(blank, 'bg')).toEqual([0xff, 0xff, 0xff]);
        expect(rgb(a, 'fg')).toEqual([0, 0, 0]);
        expect(rgb(b, 'fg')).not.toEqual([0, 0, 0]);
        expect(t.getColors().cursor).toEqual({ r: 0, g: 0, b: 0 });
      },
      {
        fgColor: 0,
        bgColor: 0xffffff,
        cursorColor: 0,
        palette: new Array(16).fill(0),
        colorPresence: { foreground: true, background: true, cursor: true, palette: 1 },
      }
    );
  });

  test('explicit black cell backgrounds stay distinct from a themed default', () => {
    withTerm(
      4,
      1,
      (t) => {
        t.write('\x1b[48;2;0;0;0mK\x1b[0mD');
        const [k, d] = t.getLine(0)!;
        expect(rgb(k, 'bg')).toEqual([0, 0, 0]);
        expect(rgb(d, 'bg')).toEqual([0x11, 0x22, 0x33]);
      },
      { bgColor: 0x112233 }
    );
  });
});

describe('libghostty-vt history', () => {
  test('history rows are read without moving the viewport', () => {
    withTerm(12, 3, (t) => {
      t.write('\x1b]8;;https://h.example\x07link\x1b]8;;\x07 e\u0301\r\n');
      for (let i = 0; i < 5; i++) t.write(`row ${i}\r\n`);
      t.write('tail');
      expect(t.getScrollbackLength()).toBe(4);
      const before = [0, 1, 2].map((y) => text(t, y));
      const cursor = t.getCursor();
      const first = t.getScrollbackLine(0)!;
      expect(
        first
          .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
          .join('')
          .trimEnd()
      ).toBe('link e');
      expect(first[0].hyperlink_id).toBeGreaterThan(0);
      expect(first[5].grapheme_len).toBe(1);
      expect(t.getScrollbackGraphemeString(0, 5)).toBe('e\u0301');
      expect(t.getScrollbackHyperlinkUri(0, 1)).toBe('https://h.example');
      expect(t.getScrollbackHyperlinkUri(0, 4)).toBeNull();
      expect(t.getScrollbackLine(4)).toBeNull();
      expect([0, 1, 2].map((y) => text(t, y))).toEqual(before);
      expect(before).toEqual(['row 3', 'row 4', 'tail']);
      expect(t.getCursor()).toEqual(cursor);
    });
  });

  test('wrapped rows report continuation', () => {
    withTerm(5, 3, (t) => {
      t.write('abcdefg');
      expect([0, 1, 2, 7].map((y) => t.isRowWrapped(y))).toEqual([false, true, false, false]);
    });
  });

  test('scrollback 0 keeps no history; the line limit bounds history page-granularly', () => {
    withTerm(
      10,
      2,
      (t) => {
        for (let i = 0; i < 50; i++) t.write(`l${i}\r\n`);
        expect(t.getScrollbackLength()).toBe(0);
      },
      { scrollbackLimit: 0 }
    );
    withTerm(
      80,
      24,
      (t) => {
        const seen = new Set<number>();
        for (let i = 0; i < 20000; i++) {
          t.write(`l${i}\r\n`);
          if (i % 500 === 499) seen.add(t.getScrollbackLength());
        }
        // The native line limit prunes whole pages: retained history oscillates
        // around the limit (observed 38..631 here), bounded but not exact.
        expect(Math.max(...seen)).toBeLessThan(1000);
        expect(Math.min(...seen)).toBeGreaterThan(0);
      },
      { scrollbackLimit: 100 }
    );
  });
});

describe('libghostty-vt replies', () => {
  test('replies keep their order within one write', () => {
    withTerm(10, 3, (t) => {
      t.write('\x1b[2;3H\x1b[6n\x1b[5n\x1b[c');
      expect(t.hasResponse()).toBe(true);
      expect(drain(t)).toEqual(['\x1b[2;3R\x1b[0n\x1b[?62;22c']);
      expect(t.hasResponse()).toBe(false);
      t.write('hello');
      expect(t.readResponse()).toBeNull();
    });
  });

  test('long replies are chunked without splitting UTF-8', () => {
    withTerm(10, 2, (t) => {
      const impl = (
        t as unknown as {
          impl: {
            abi: {
              alloc(n: number): number;
              bytes(): Uint8Array;
              free(p: number, n: number): void;
            };
            onWritePty(p: number, n: number): void;
          };
        }
      ).impl;
      const reply = `${'x'.repeat(255)}é${'y'.repeat(300)}€`;
      const bytes = new TextEncoder().encode(reply);
      const ptr = impl.abi.alloc(bytes.length);
      impl.abi.bytes().set(bytes, ptr);
      impl.onWritePty(ptr, 100);
      impl.onWritePty(ptr + 100, bytes.length - 100);
      impl.abi.free(ptr, bytes.length);
      const chunks = drain(t);
      expect(chunks.join('')).toBe(reply);
      expect(chunks[0].length).toBe(255);
      expect(chunks.every((c) => !c.includes('\uFFFD'))).toBe(true);
    });
  });
});

describe('libghostty-vt key encoder', () => {
  const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

  test('encodes through the current ABI with public enums', () => {
    const k = fresh().createKeyEncoder();
    const press = (key: Key, mods = Mods.NONE, utf8?: string) =>
      hex(k.encode({ action: KeyAction.PRESS, key, mods, utf8 }));
    expect(press(Key.A, Mods.NONE, 'a')).toBe('61');
    expect(press(Key.E, Mods.NONE, 'é')).toBe('c3a9');
    expect(press(Key.C, Mods.CTRL, 'c')).toBe('03');
    expect(press(Key.ZERO, Mods.NONE, '0')).toBe('30');
    expect(press(Key.UP)).toBe('1b5b41');
    k.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, true);
    expect(press(Key.UP)).toBe('1b4f41');
    k.setKittyFlags(KittyKeyFlags.DISAMBIGUATE);
    expect(press(Key.ESCAPE)).toBe('1b5b323775');
    expect(hex(k.encode({ action: KeyAction.RELEASE, key: Key.ESCAPE, mods: Mods.NONE }))).toBe('');
    expect(() => k.setKittyFlags(256 as KittyKeyFlags)).toThrow(
      'Kitty keyboard flags must be 0..255'
    );
    k.dispose();
  });
});

describe('libghostty-vt host integration', () => {
  test('size reports are declined until real cell metrics are known', () => {
    withTerm(20, 5, (t) => {
      t.write('\x1b[18t\x1b[14t\x1b[16t\x1b[?2048h');
      expect(drain(t)).toEqual([]);
      t.setCellPixelSize(8, 16);
      // Re-applying the size with metrics sends the enabled mode 2048 report.
      expect(drain(t)).toEqual(['\x1b[48;5;20;80;160t']);
      t.write('\x1b[18t\x1b[14t\x1b[16t');
      expect(drain(t)).toEqual(['\x1b[8;5;20t\x1b[4;80;160t\x1b[6;16;8t']);
      t.setCellPixelSize(8.2, 15.8);
      expect(drain(t)).toEqual([]);
      t.resize(30, 6);
      expect(drain(t)).toEqual(['\x1b[48;6;30;96;240t']);
      expect(() => t.setCellPixelSize(0, 16)).toThrow('cell width must be 1..65535 px');
    });
  });

  test('mouse tracking follows the native event mode, not stale mode bits', () => {
    withTerm(10, 2, (t) => {
      const steps: [string, boolean, boolean][] = [];
      expect(t.hasMouseTracking()).toBe(false);
      for (const seq of ['\x1b[?1000h', '\x1b[?1002h', '\x1b[?1002l', '\x1b[?9h', '\x1b[?9l']) {
        t.write(seq);
        steps.push([seq, t.hasMouseTracking(), t.getMode(1000)]);
      }
      expect(steps).toEqual([
        ['\x1b[?1000h', true, true],
        ['\x1b[?1002h', true, true],
        // Mode bit 1000 stays set, but the single native event mode is now none.
        ['\x1b[?1002l', false, true],
        ['\x1b[?9h', true, true],
        ['\x1b[?9l', false, true],
      ]);
      t.write('\x1b[?1003h');
      expect(t.hasMouseTracking()).toBe(true);
      expect(drain(t)).toEqual([]);
    });
  });

  test('Kitty flags and key encoder sync come from the terminal', () => {
    const g = fresh();
    const t = g.createTerminal(10, 2);
    const k = g.createKeyEncoder();
    const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
    const press = (key: Key) => hex(k.encode({ action: KeyAction.PRESS, key, mods: Mods.NONE }));
    expect(t.getKittyKeyboardFlags()).toBe(0);
    t.write('\x1b[>5u');
    expect(t.getKittyKeyboardFlags()).toBe(5);
    t.write('\x1b[<u');
    expect(t.getKittyKeyboardFlags()).toBe(0);
    t.write('\x1b[?1h');
    expect(press(Key.UP)).toBe('1b5b41');
    k.syncFromTerminal(t);
    expect(press(Key.UP)).toBe('1b4f41');
    t.write('\x1b[>1u');
    k.syncFromTerminal(t);
    expect(press(Key.ESCAPE)).toBe('1b5b323775');
    const other = fresh().createTerminal(10, 2);
    expect(() => k.syncFromTerminal(other)).toThrow('needs a terminal from the same instance');
    other.free();
    t.free();
    expect(() => k.syncFromTerminal(t)).toThrow('GhosttyTerminal has been freed');
    k.dispose();
  });

  test('the default cursor applies unless the program chose one', () => {
    withTerm(10, 2, (t) => {
      const look = () => {
        const c = t.getCursor();
        return [c.style, c.blinking];
      };
      expect(look()).toEqual(['block', false]);
      t.setDefaultCursorStyle('bar', true);
      expect(look()).toEqual(['bar', true]);
      t.write('\x1b[2 q');
      t.setDefaultCursorStyle('underline', false);
      expect(look()).toEqual(['block', false]);
      t.write('\x1b[0 q');
      expect(look()).toEqual(['underline', false]);
    });
  });

  test('cells report whether fg/bg are the defaults', () => {
    withTerm(10, 2, (t) => {
      t.write('\x1b[31;40mA\x1b[0mB\x1b[48;2;0;0;0mC');
      const [a, b, c] = t.getLine(0)!;
      expect([a.fg_default, a.bg_default]).toEqual([false, false]);
      expect([b.fg_default, b.bg_default]).toEqual([true, true]);
      expect([c.fg_default, c.bg_default, ...rgb(c, 'bg')]).toEqual([true, false, 0, 0, 0]);
      expect(t.getScrollbackLength()).toBe(0);
    });
  });
});
