/**
 * L7: public API contracts that a backend migration must preserve: write,
 * buffer, selection and modes. Expected semantics are ghostty-web's documented
 * xterm.js-compatible API, checked against @xterm/headless 5.5 where noted.
 * Everything goes through public `Terminal` members.
 */
import { describe, regressionCase } from '../../regression/core/harness/scenario';
import { bufferLines, withTerminal } from '../../regression/core/harness/web';

const E = '\x1b';

function errorOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}

describe('write', () => {
  regressionCase('api.write-string-and-bytes', (checks) => {
    return withTerminal({ cols: 10, rows: 2 }, ({ term }) => {
      term.write('ab');
      term.write(new TextEncoder().encode('c\u00e9'));
      checks.equal('lines', bufferLines(term), ['ab' + 'c\u00e9', '']);
    });
  });

  regressionCase('api.writeln', (checks) => {
    return withTerminal({ cols: 10, rows: 3 }, ({ term }) => {
      term.writeln('one');
      term.writeln(new TextEncoder().encode('two'));
      checks.equal('lines', bufferLines(term), ['one', 'two', '']);
    });
  });

  regressionCase('api.write-callback-after-parse', async (checks) => {
    await withTerminal({ cols: 10, rows: 2 }, async ({ term }) => {
      let calls = 0;
      const seen = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('write callback not called within 2s')),
          2000
        );
        term.write('cb', () => {
          calls++;
          clearTimeout(timer);
          resolve(term.buffer.active.getLine(0)?.translateToString(true) ?? '');
        });
      });
      checks.equal('line-at-callback', seen, 'cb');
      checks.equal('calls', calls, 1);
    });
  });

  regressionCase('api.write-empty-string-is-noop', (checks) => {
    return withTerminal({ cols: 10, rows: 2 }, ({ term }) => {
      checks.equal(
        'error',
        errorOf(() => term.write('')),
        null
      );
    });
  });
});

describe('buffer', () => {
  regressionCase('api.buffer-cursor', (checks) => {
    return withTerminal({ cols: 10, rows: 3 }, ({ term }) => {
      term.write(`${E}[2;4Hx`);
      checks.equal('cursor', [term.buffer.active.cursorX, term.buffer.active.cursorY], [4, 1]);
    });
  });

  regressionCase('api.buffer-history-offsets', (checks) => {
    return withTerminal({ cols: 20, rows: 4, scrollback: 1000 }, ({ term }) => {
      term.write(Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join('') + 'PROMPT$ ');
      const buffer = term.buffer.active;
      checks.equal('base-at-live-screen', buffer.baseY, 27);
      checks.equal(
        'cursor-line',
        buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true),
        'PROMPT$'
      );
      term.scrollLines(-5);
      checks.equal('viewport-top', buffer.viewportY, 22);
      checks.equal(
        'viewport-line',
        buffer.getLine(buffer.viewportY)?.translateToString(true),
        'line 22'
      );
      term.viewportY = 5.75;
      checks.equal('fractional-viewport', buffer.viewportY, 22);
      term.scrollToTop();
      checks.equal('oldest-row', buffer.viewportY, 0);
      term.scrollToBottom();
      checks.equal('following', buffer.viewportY, buffer.baseY);
      term.write(`${E}[?1049h`);
      checks.equal(
        'alternate-offsets',
        [term.buffer.active.baseY, term.buffer.active.viewportY],
        [0, 0]
      );
      term.write(`${E}[?1049l`);
      checks.equal('restored-normal-base', term.buffer.active.baseY, 27);
      term.reset();
      checks.equal(
        'reset-offsets',
        [term.buffer.active.baseY, term.buffer.active.viewportY],
        [0, 0]
      );
    });
  });

  regressionCase('api.resize-clamps-history-viewport', (checks) => {
    return withTerminal({ cols: 80, rows: 4, scrollback: 1000 }, ({ term }) => {
      term.write(Array.from({ length: 100 }, (_, i) => `line ${i}\r\n`).join(''));
      term.scrollToTop();
      const scrolls: number[] = [];
      term.onScroll((offset) => scrolls.push(offset));
      term.resize(80, 10);
      checks.equal('history-was-pulled', term.getScrollbackLength(), 91);
      checks.equal('clamped-offset', term.getViewportY(), 91);
      checks.equal('notification', scrolls, [91]);
      checks.equal(
        'oldest-row-readable',
        term.buffer.active.getLine(0)?.translateToString(true),
        'line 0'
      );
    });
  });

  regressionCase('api.buffer-is-wrapped', (checks) => {
    return withTerminal({ cols: 5, rows: 3 }, ({ term }) => {
      term.write('abcdefg');
      const buffer = term.buffer.active;
      checks.equal(
        'is-wrapped',
        [0, 1, 2].map((y) => buffer.getLine(y)?.isWrapped),
        [false, true, false]
      );
    });
  });

  regressionCase('api.buffer-active-type', (checks) => {
    return withTerminal({ cols: 10, rows: 2 }, ({ term }) => {
      const types = [term.buffer.active.type];
      term.write(`${E}[?1049h`);
      types.push(term.buffer.active.type);
      term.write(`${E}[?1049l`);
      types.push(term.buffer.active.type);
      checks.equal('types', types, ['normal', 'alternate', 'normal']);
    });
  });

  regressionCase('api.buffer-translate-keeps-blank-cells', (checks) => {
    // xterm.js translateToString renders empty cells as spaces ('a   b').
    return withTerminal({ cols: 10, rows: 2 }, ({ term }) => {
      term.write(`a${E}[3Cb`);
      checks.equal('text', term.buffer.active.getLine(0)?.translateToString(true), 'a   b');
    });
  });

  regressionCase('api.buffer-normal-while-alternate', (checks) => {
    return withTerminal({ cols: 10, rows: 2 }, ({ term }) => {
      term.write(`MAIN${E}[?1049hALT`);
      checks.equal('normal-row0', term.buffer.normal.getLine(0)?.translateToString(true), 'MAIN');
    });
  });

  regressionCase('api.buffer-get-chars-grapheme', (checks) => {
    return withTerminal({ cols: 10, rows: 2 }, ({ term }) => {
      term.write('e\u0301x');
      checks.equal('chars', term.buffer.active.getLine(0)?.getCell(0)?.getChars(), 'e\u0301');
    });
  });
});

describe('selection', () => {
  regressionCase('api.select-basic', (checks) => {
    return withTerminal({ cols: 20, rows: 4 }, ({ term }) => {
      term.write('hello world');
      term.select(0, 0, 5);
      checks.equal('selection', term.getSelection(), 'hello');
      checks.equal('has-selection', term.hasSelection(), true);
      term.clearSelection();
      checks.equal('cleared', [term.hasSelection(), term.getSelection()], [false, '']);
    });
  });

  regressionCase('api.select-lines', (checks) => {
    return withTerminal({ cols: 20, rows: 4 }, ({ term }) => {
      term.write('one\r\ntwo\r\nthree');
      term.selectLines(0, 1);
      checks.equal(
        'selection',
        term
          .getSelection()
          .split('\n')
          .map((l) => l.trimEnd()),
        ['one', 'two']
      );
    });
  });

  regressionCase('api.selection-change-event', (checks) => {
    return withTerminal({ cols: 20, rows: 4 }, ({ term }) => {
      let events = 0;
      term.onSelectionChange(() => {
        events++;
      });
      term.write('hello');
      term.select(0, 0, 3);
      checks.equal('fired', events > 0, true);
    });
  });

  regressionCase('api.select-wide-characters', (checks) => {
    // WEB-08: spacer cells must not add spaces.
    return withTerminal({ cols: 20, rows: 4 }, ({ term }) => {
      term.write('\u4e2d\u6587abc');
      term.select(0, 0, 7);
      checks.equal('selection', term.getSelection(), '\u4e2d\u6587abc');
    });
  });

  regressionCase('api.select-soft-wrapped-line', (checks) => {
    // WEB-08: native selection text unwraps soft-wrapped rows.
    return withTerminal({ cols: 20, rows: 4 }, ({ term }) => {
      term.write('A'.repeat(25));
      term.selectLines(0, 1);
      checks.equal('selection', term.getSelection(), 'A'.repeat(25));
    });
  });

  regressionCase('api.select-all-includes-history', (checks) => {
    return withTerminal({ cols: 20, rows: 4 }, ({ term }) => {
      for (let i = 0; i < 12; i++) term.write(`line${i}\r\n`);
      term.write('line12');
      term.selectAll();
      const lines = term
        .getSelection()
        .split('\n')
        .map((l) => l.trimEnd());
      checks.equal('first-last', [lines[0], lines[lines.length - 1]], ['line0', 'line12']);
    });
  });
});

describe('modes', () => {
  regressionCase('api.get-mode', (checks) => {
    return withTerminal({ cols: 10, rows: 2 }, ({ term }) => {
      const before = [term.getMode(2004), term.hasBracketedPaste(), term.getMode(25)];
      term.write(`${E}[?2004h${E}[?25l`);
      const after = [term.getMode(2004), term.hasBracketedPaste(), term.getMode(25)];
      checks.equal(
        'modes',
        { before, after },
        { before: [false, false, true], after: [true, true, false] }
      );
    });
  });

  regressionCase('api.mouse-tracking-mode', (checks) => {
    return withTerminal({ cols: 10, rows: 2 }, ({ term }) => {
      const states = [term.hasMouseTracking()];
      term.write(`${E}[?1000h`);
      states.push(term.hasMouseTracking());
      term.write(`${E}[?1000l`);
      states.push(term.hasMouseTracking());
      checks.equal('tracking', states, [false, true, false]);
    });
  });
});
