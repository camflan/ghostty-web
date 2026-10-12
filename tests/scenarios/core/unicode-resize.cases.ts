import { splitAt } from '../../regression/core/harness/chunking';
import { engineIdentity } from '../../regression/core/harness/identity';
/**
 * L1/L3: UTF-8 fragmentation, wide/grapheme boundaries, resize/reflow and
 * scrollback semantics. Wide and grapheme assertions are explicit here rather
 * than in the single-cell VT corpus.
 */
import {
  abiCase,
  describe,
  expect,
  legacyAbiCase,
  regressionCase,
  test,
} from '../../regression/core/harness/scenario';
import {
  bufferLines,
  cellsOf,
  guarded,
  observe,
  rawSession,
  utf8,
  wasmTerm,
  withTerminal,
} from '../../regression/core/harness/web';
import { ReferenceModule } from '../../regression/reference/loader';

const E = '\x1b';

describe('fragmentation', () => {
  regressionCase('frag.utf8-4byte-split', (checks) => {
    const session = rawSession(10, 2);
    guarded(
      () => {
        const bytes = utf8('\u{1f600}Z');
        for (const chunk of splitAt(bytes, [2])) session.write(chunk);
        checks.equal('cells', cellsOf(session.term, 0).slice(0, 3), [
          [0x1f600, 2],
          [0, 0],
          [0x5a, 1],
        ]);
      },
      () => session.free()
    );
  });

  regressionCase('frag.utf8-every-offset', (checks) => {
    const text = `a\u00e9\u2713\u{1f600}b${E}[2;3HX`;
    const bytes = utf8(text);
    const whole = rawSession(12, 3);
    whole.write(bytes);
    const expected = whole.observe();
    whole.free();
    for (let offset = 1; offset < bytes.length; offset++) {
      const split = rawSession(12, 3);
      guarded(
        () => {
          for (const chunk of splitAt(bytes, [offset])) split.write(chunk);
          checks.equal(`offset-${offset}`, split.observe(), expected);
        },
        () => split.free()
      );
    }
  });

  regressionCase('frag.csi-split-mid-parameters', (checks) => {
    const session = rawSession(5, 3);
    guarded(
      () => {
        session.write(`${E}[2;`);
        session.write('3HX');
        checks.equal('observation', session.observe(), {
          lines: ['', '  X', ''],
          cursor: { x: 3, y: 1 },
        });
      },
      () => session.free()
    );
  });

  regressionCase('frag.string-surrogate-pair-split', (checks) => {
    // xterm.js keeps a high surrogate pending across write(string) calls.
    const session = rawSession(10, 2);
    guarded(
      () => {
        session.write('\ud83d');
        session.write('\ude00Z');
        checks.equal('cells', cellsOf(session.term, 0).slice(0, 3), [
          [0x1f600, 2],
          [0, 0],
          [0x5a, 1],
        ]);
      },
      () => session.free()
    );
  });

  test('negative control: per-chunk TextDecoder corrupts a split code point', () => {
    const session = rawSession(10, 2);
    guarded(
      () => {
        for (const chunk of splitAt(utf8('\u{1f600}Z'), [2]))
          session.write(new TextDecoder().decode(chunk));
        expect(cellsOf(session.term, 0)[0][0]).toBe(0xfffd);
      },
      () => session.free()
    );
  });
});

describe('wide characters and graphemes', () => {
  regressionCase('wide.cjk-occupies-two-cells', (checks) => {
    const session = rawSession(5, 2);
    guarded(
      () => {
        session.write('\u4e00');
        checks.equal('cells', cellsOf(session.term, 0).slice(0, 2), [
          [0x4e00, 2],
          [0, 0],
        ]);
        checks.equal('cursor', session.observe().cursor, { x: 2, y: 0 });
      },
      () => session.free()
    );
  });

  regressionCase('wide.wraps-at-right-margin', (checks) => {
    return withTerminal({ cols: 5, rows: 2 }, ({ term }) => {
      term.write('abcd\u4e00');
      checks.equal('observation', observe(wasmTerm(term)), {
        lines: ['abcd', '\u4e00'],
        cursor: { x: 2, y: 1 },
      });
      checks.equal('row1-is-wrapped', term.buffer.active.getLine(1)?.isWrapped, true);
    });
  });

  regressionCase('wide.print-over-spacer-tail', (checks) => {
    // upstream Terminal.zig test "Terminal: print over wide spacer tail"
    const session = rawSession(5, 2);
    guarded(
      () => {
        session.write(`\u4e00${E}[1;2HX`);
        checks.equal('cells', cellsOf(session.term, 0).slice(0, 2), [
          [0, 1],
          [0x58, 1],
        ]);
      },
      () => session.free()
    );
  });

  regressionCase('grapheme.combining-mark-one-cell', (checks) => {
    const session = rawSession(10, 2);
    guarded(
      () => {
        session.write('e\u0301x');
        // observe() refreshes the render state; the grapheme getter reads it as-is.
        checks.equal('observation', session.observe(), {
          lines: ['e\u0301x', ''],
          cursor: { x: 2, y: 0 },
        });
        checks.equal('grapheme', session.term.getGraphemeString(0, 0), 'e\u0301');
      },
      () => session.free()
    );
  });

  regressionCase('grapheme.zwj-family-one-wide-cell', (checks) => {
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
    const session = rawSession(10, 2);
    guarded(
      () => {
        session.write(`${family}|`);
        checks.equal('cursor', session.observe().cursor, { x: 3, y: 0 });
        checks.equal('grapheme', session.term.getGraphemeString(0, 0), family);
      },
      () => session.free()
    );
  });

  regressionCase('grapheme.mode-2027-default-on', (checks) => {
    return withTerminal({}, ({ term }) => checks.equal('mode-2027', term.getMode(2027), true));
  });

  regressionCase('grapheme.clustering-survives-ris', (checks) => {
    // WEB-15: the patch sets 2027 after init instead of as a default, so RIS clears it.
    const session = rawSession(10, 2);
    guarded(
      () => {
        session.write(`${E}c\u{1f44d}\u{1f3fd}|`);
        checks.equal('cursor-x', session.observe().cursor.x, 3);
      },
      () => session.free()
    );
  });
});

describe('resize and reflow', () => {
  regressionCase('resize.deccolm-keeps-host-grid-renderable', async (checks) => {
    for (const cols of [80, 100]) {
      await withTerminal({ cols, rows: 3 }, ({ term }) => {
        term.write(`${E}[?40h`);
        for (const mode of ['h', 'l']) {
          // Fragment the sequence too: parser-driven resizing must not leave
          // the native grid out of sync with the host-sized renderer/cache.
          term.write(`${E}[?3`);
          term.write(mode);
          term.resize(cols, 3); // Same-size fits must remain safe, even if elided.
          const wasm = wasmTerm(term);
          wasm.update();
          checks.equal(`grid-${cols}-${mode}`, [term.cols, term.rows], [cols, 3]);
          checks.equal(
            `row-widths-${cols}-${mode}`,
            [0, 1, 2].map((y) => wasm.getLine(y)?.length),
            [cols, cols, cols]
          );
          // The legacy ABI blanks this unsupported resized viewport, but must
          // still allow reads. Native must not introduce a render-loop exception.
          checks.equal(
            `cursor-readable-${cols}-${mode}`,
            Number.isInteger(wasm.getCursor().x),
            true
          );
        }
        term.resize(72, 4);
        term.write(`${E}[4;72H#`);
        wasmTerm(term).update();
        checks.equal(`host-resize-${cols}`, wasmTerm(term).getLine(3)?.length, 72);
        checks.equal(
          `output-after-host-resize-${cols}`,
          wasmTerm(term).getLine(3)?.[71].codepoint,
          35
        );
      });
    }
  });

  regressionCase('resize.reflow-shrink', (checks) => {
    return withTerminal({ cols: 10, rows: 3 }, ({ term }) => {
      term.write('abcdefghij');
      term.resize(5, 3);
      checks.equal('lines', bufferLines(term), ['abcde', 'fghij', '']);
      checks.equal('row1-is-wrapped', term.buffer.active.getLine(1)?.isWrapped, true);
    });
  });

  regressionCase('resize.reflow-grow-joins-soft-wrap', (checks) => {
    return withTerminal({ cols: 5, rows: 3 }, ({ term }) => {
      term.write('abcdefgh');
      term.resize(10, 3);
      checks.equal('lines', bufferLines(term), ['abcdefgh', '', '']);
    });
  });

  regressionCase('resize.hard-newlines-not-joined', (checks) => {
    return withTerminal({ cols: 5, rows: 3 }, ({ term }) => {
      term.write('ab\r\ncd');
      term.resize(10, 3);
      checks.equal('lines', bufferLines(term), ['ab', 'cd', '']);
    });
  });

  regressionCase('resize.on-resize-event', (checks) => {
    return withTerminal({ cols: 10, rows: 3 }, ({ term }) => {
      const events: Array<{ cols: number; rows: number }> = [];
      term.onResize((e) => events.push(e));
      term.resize(12, 4);
      term.resize(12, 4);
      checks.equal('events', events, [{ cols: 12, rows: 4 }]);
      checks.equal('dimensions', [term.cols, term.rows], [12, 4]);
    });
  });

  regressionCase('resize.narrow-drops-orphan-wide-head', (checks) => {
    // SW-01 (upstream e6db5b633): narrowing must not leave a wide head without its tail.
    return withTerminal({ cols: 3, rows: 2 }, ({ term }) => {
      term.write(`${E}[?7la\u4e00\r\nXYZ`);
      term.resize(2, 2);
      checks.equal('row0-cells', cellsOf(wasmTerm(term), 0), [
        [0x61, 1],
        [0, 1],
      ]);
    });
  });
});

describe('scrollback', () => {
  regressionCase('scrollback.buffer-order', (checks) => {
    return withTerminal({ cols: 10, rows: 3 }, ({ term }) => {
      term.write('L0\r\nL1\r\nL2\r\nL3\r\nL4');
      checks.equal('lines', bufferLines(term), ['L0', 'L1', 'L2', 'L3', 'L4']);
      checks.equal('scrollback-length', term.getScrollbackLength(), 2);
    });
  });

  regressionCase('scrollback.zero-means-none', (checks) => {
    // Zero disables history on the native contract (legacy keeps its documented failure).
    return withTerminal({ cols: 80, rows: 24, scrollback: 0 }, ({ term }) => {
      for (let i = 0; i < 100; i++) term.write(`line${i}\r\n`);
      checks.equal('scrollback-length', term.getScrollbackLength(), 0);
    });
  });

  // Preserve the old exact-line comparison only for the legacy compatibility ABI.
  // The native contract was explicitly changed to upstream page-granular retention.
  legacyAbiCase('scrollback.limit-is-lines', (checks) => {
    return withTerminal({ cols: 80, rows: 24, scrollback: 100 }, ({ term }) => {
      for (let i = 0; i < 1000; i++) term.write(`line${i}\r\n`);
      // xterm.js (@xterm/headless 5.5) retains exactly the requested 100 lines.
      checks.equal('retained-lines', term.getScrollbackLength(), 100);
    });
  });

  abiCase('libghostty-vt', 'scrollback.native-retention-matches-upstream', async (checks) => {
    // Integration oracle: independently configure the same upstream core, not an
    // observed magic row count such as 304. Positive limits prune whole pages.
    const module = ReferenceModule.fromFile(engineIdentity().wasmPath);
    const outcomes: { limit: number; pruned: boolean }[] = [];
    for (const limit of [100, 2000]) {
      await withTerminal({ cols: 80, rows: 24, scrollback: limit }, ({ term }) => {
        const reference = module.instantiate();
        return guarded(
          () => {
            const native = reference.createTerminal(80, 24);
            native.setMode(2027, true, { asDefault: true });
            native.setSizeOption('SCROLLBACK_MAX_BYTES', null);
            native.setSizeOption('SCROLLBACK_MAX_LINES', limit);
            let pruned = false;
            for (let first = 0; first < 1500; first += 125) {
              const input = Array.from({ length: 125 }, (_, n) => `line${first + n}\r\n`).join('');
              term.write(input);
              native.write(input);
              const retained = term.getScrollbackLength();
              const totalLines = first + 126; // includes the empty row after the final CRLF
              const historyWithoutPruning = totalLines - 24;
              pruned ||= retained < historyWithoutPruning;
              checks.equal(
                `limit-${limit}-after-${first + 125}-retention`,
                retained,
                native.scrollbackRows()
              );
              checks.equal(
                `limit-${limit}-after-${first + 125}-buffer-length`,
                term.buffer.active.length,
                native.totalRows()
              );
              // Recent and oldest accessible content must still be contiguous and exact.
              checks.equal(
                `limit-${limit}-after-${first + 125}-oldest`,
                term.buffer.active.getLine(0)?.translateToString(true),
                `line${totalLines - term.buffer.active.length}`
              );
              checks.equal(
                `limit-${limit}-after-${first + 125}-newest`,
                term.buffer.active.getLine(term.buffer.active.length - 2)?.translateToString(true),
                `line${first + 124}`
              );
              checks.equal(
                `limit-${limit}-after-${first + 125}-no-errors`,
                native.vtProcessingError(),
                false
              );
            }
            outcomes.push({ limit, pruned });
          },
          () => reference.dispose()
        );
      });
    }
    // A dropped limit cannot pass by comparing two unbounded histories; the
    // small budget must prune, while the large budget retains this entire input.
    checks.equal('configured-budgets-affect-retention', outcomes, [
      { limit: 100, pruned: true },
      { limit: 2000, pruned: false },
    ]);
  });
});
