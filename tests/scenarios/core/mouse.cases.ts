/**
 * L2: byte-exact mouse reports (WEB-06, IN-08, IN-09, IN-10).
 *
 * Synthetic happy-dom mouse/wheel events at cell centres. Native expectations
 * follow pinned `Surface.mouseReport` (modifier bits Shift 4 / Alt 8 / Ctrl 16,
 * no-button motion 35, X10 limited to column/row 223, per-cell motion
 * de-duplication, Shift bypass with mouse-shift-capture=false) and the core
 * mode handling in `stream_readonly.zig` (last mode wins; any reset turns
 * reporting off). Output is compared as wire bytes: UTF-8 onData plus raw onBinary.
 */
import { describe, regressionCase } from '../../regression/core/harness/scenario';
import {
  type WebSession,
  guarded,
  hex,
  hexChunks,
  mouseAt,
  openTerminal,
  wheelAt,
} from '../../regression/core/harness/web';

const E = '\x1b';
const SGR = `${E}[?1000h${E}[?1006h`;

function reports(
  setup: string,
  act: (s: WebSession) => void,
  options: { cols?: number; rows?: number } = {}
): string[] {
  const session = openTerminal({ cols: options.cols ?? 40, rows: options.rows ?? 10 });
  return guarded(
    () => {
      if (setup) session.term.write(setup);
      session.data.length = 0;
      // Exercise the public transport contract without changing byte oracles:
      // onData is UTF-8, while xterm-style onBinary carries one code unit/byte.
      const output: (string | Uint8Array)[] = [];
      session.term.onData((data) => output.push(data));
      session.term.onBinary((data) =>
        output.push(Uint8Array.from(data, (char) => char.charCodeAt(0)))
      );
      act(session);
      return hexChunks(output);
    },
    () => session.dispose()
  );
}

const press = (s: WebSession, col: number, row: number, init: MouseEventInit = {}) =>
  mouseAt(s, 'mousedown', col, row, { button: 0, ...init });
const release = (s: WebSession, col: number, row: number, init: MouseEventInit = {}) =>
  mouseAt(s, 'mouseup', col, row, { button: 0, ...init });

describe('mouse: SGR (1006) reports', () => {
  regressionCase('mouse.no-tracking-no-report', (checks) => {
    checks.equal(
      'output.bytes',
      reports('', (s) => press(s, 4, 2)),
      []
    );
  });
  regressionCase('mouse.sgr-left-press-release', (checks) => {
    checks.equal(
      'output.bytes',
      reports(SGR, (s) => {
        press(s, 4, 2);
        release(s, 4, 2);
      }),
      [hex(`${E}[<0;4;2M`), hex(`${E}[<0;4;2m`)]
    );
  });
  regressionCase('mouse.sgr-right-press', (checks) => {
    checks.equal(
      'output.bytes',
      reports(SGR, (s) => press(s, 7, 3, { button: 2 })),
      [hex(`${E}[<2;7;3M`)]
    );
  });
  regressionCase('mouse.sgr-ctrl-press', (checks) => {
    checks.equal(
      'output.bytes',
      reports(SGR, (s) => press(s, 4, 2, { ctrlKey: true })),
      [hex(`${E}[<16;4;2M`)]
    );
  });
  regressionCase('mouse.sgr-alt-press', (checks) => {
    checks.equal(
      'output.bytes',
      reports(SGR, (s) => press(s, 4, 2, { altKey: true })),
      [hex(`${E}[<8;4;2M`)]
    );
  });
  regressionCase('mouse.sgr-meta-press', (checks) => {
    // Super/Meta has no bit in xterm mouse encodings.
    checks.equal(
      'output.bytes',
      reports(SGR, (s) => press(s, 4, 2, { metaKey: true })),
      [hex(`${E}[<0;4;2M`)]
    );
  });
  regressionCase('mouse.shift-bypasses-reporting', (checks) => {
    // mouse-shift-capture defaults to false: Shift+click is for local selection.
    checks.equal(
      'output.bytes',
      reports(SGR, (s) => press(s, 4, 2, { shiftKey: true })),
      []
    );
  });
});

describe('mouse: motion', () => {
  regressionCase('mouse.button-motion', (checks) => {
    checks.equal(
      'output.bytes',
      reports(`${E}[?1002h${E}[?1006h`, (s) => {
        press(s, 4, 2);
        mouseAt(s, 'mousemove', 5, 2, { buttons: 1 });
      }),
      [hex(`${E}[<0;4;2M`), hex(`${E}[<32;5;2M`)]
    );
  });
  regressionCase('mouse.button-motion-without-button-silent', (checks) => {
    checks.equal(
      'output.bytes',
      reports(`${E}[?1002h${E}[?1006h`, (s) => mouseAt(s, 'mousemove', 5, 2)),
      []
    );
  });
  regressionCase('mouse.motion-deduplicated-per-cell', (checks) => {
    checks.equal(
      'output.bytes',
      reports(`${E}[?1002h${E}[?1006h`, (s) => {
        press(s, 4, 2);
        mouseAt(s, 'mousemove', 5, 2, { buttons: 1 }, 0.25);
        mouseAt(s, 'mousemove', 5, 2, { buttons: 1 }, 0.75);
      }),
      [hex(`${E}[<0;4;2M`), hex(`${E}[<32;5;2M`)]
    );
  });
  regressionCase('mouse.any-motion-no-button', (checks) => {
    checks.equal(
      'output.bytes',
      reports(`${E}[?1003h${E}[?1006h`, (s) => mouseAt(s, 'mousemove', 10, 3)),
      [hex(`${E}[<35;10;3M`)]
    );
  });
});

describe('mouse: legacy encodings and mode state', () => {
  regressionCase('mouse.x10-normal-small-coords', (checks) => {
    // ESC [ M, then 32+button, 32+col, 32+row (all ASCII here).
    checks.equal(
      'output.bytes',
      reports(`${E}[?1000h`, (s) => press(s, 3, 3)),
      [hex(`${E}[M ##`)]
    );
  });
  regressionCase('mouse.x10-col100-raw-byte', (checks) => {
    // Native emits the raw byte 0x84 (32 + 100); it is not valid UTF-8 (IN-10).
    checks.equal(
      'output.bytes',
      reports(`${E}[?1000h`, (s) => press(s, 100, 5), { cols: 120, rows: 10 }),
      ['1b5b4d208425']
    );
  });
  regressionCase('mouse.x10-beyond-223-dropped', (checks) => {
    checks.equal(
      'output.bytes',
      reports(`${E}[?1000h`, (s) => press(s, 230, 5), { cols: 240, rows: 10 }),
      []
    );
  });
  regressionCase('mouse.x10-mode9-press', (checks) => {
    // Mode 9 (X10 compatibility): press only, no modifiers.
    checks.equal(
      'output.bytes',
      reports(`${E}[?9h`, (s) => press(s, 3, 3)),
      ['1b5b4d202323']
    );
  });
  regressionCase('mouse.mode-reset-turns-reporting-off', (checks) => {
    // Native: the event mode is one value; resetting 1002 sets it to none (IN-09).
    checks.equal(
      'output.bytes',
      reports(`${E}[?1000h${E}[?1002h${E}[?1002l${E}[?1006h`, (s) => press(s, 4, 2)),
      []
    );
  });
});

describe('mouse: wheel', () => {
  regressionCase('mouse.wheel-reported-when-tracking', (checks) => {
    checks.equal(
      'output.bytes',
      reports(SGR, (s) => wheelAt(s, 4, 2, -100)),
      [hex(`${E}[<64;4;2M`)]
    );
  });
  regressionCase('mouse.wheel-alt-screen-tracking', (checks) => {
    checks.equal(
      'output.bytes',
      reports(`${E}[?1049h${SGR}`, (s) => wheelAt(s, 4, 2, 100)),
      [hex(`${E}[<65;4;2M`)]
    );
  });
});
