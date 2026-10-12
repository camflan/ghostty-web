/**
 * L2: paste encoding (WEB-12, IN-12) and focus reports (IN-07) through the
 * public `Terminal.paste()`, `focus()` and `blur()` API.
 *
 * Paste expectations follow Ghostty's paste encoder at the migration target
 * (`src/input/paste.zig` at 8f0dd370: control bytes NUL/BS/ENQ/EOT/ESC/DEL and
 * the termios specials become spaces; `\n` becomes `\r` when not bracketed).
 * Focus expectations follow native termio: `ESC[I`/`ESC[O` on focus changes
 * while mode 1004 is set, and the current state when the mode is enabled.
 */
import { describe, regressionCase } from '../../regression/core/harness/scenario';
import {
  type WebSession,
  guarded,
  hex,
  hexChunks,
  openTerminal,
} from '../../regression/core/harness/web';

const E = '\x1b';

function emitted(setup: string, act: (s: WebSession) => void, disableStdin = false): string[] {
  const session = openTerminal({ disableStdin });
  return guarded(
    () => {
      if (setup) session.term.write(setup);
      session.data.length = 0;
      act(session);
      return hexChunks(session.data);
    },
    () => session.dispose()
  );
}

describe('paste', () => {
  regressionCase('paste.plain-text', (checks) => {
    checks.equal(
      'output.bytes',
      emitted('', (s) => s.term.paste('hello')),
      [hex('hello')]
    );
  });
  regressionCase('paste.bracketed-plain', (checks) => {
    checks.equal(
      'output.bytes',
      emitted(`${E}[?2004h`, (s) => s.term.paste('hi')),
      [hex(`${E}[200~hi${E}[201~`)]
    );
  });
  regressionCase('paste.bracketed-keeps-newline', (checks) => {
    checks.equal(
      'output.bytes',
      emitted(`${E}[?2004h`, (s) => s.term.paste('a\nb')),
      [hex(`${E}[200~a\nb${E}[201~`)]
    );
  });
  regressionCase('paste.disable-stdin-suppresses', (checks) => {
    checks.equal(
      'output.bytes',
      emitted('', (s) => s.term.paste('x'), true),
      []
    );
  });
  regressionCase('paste.unbracketed-newline-to-cr', (checks) => {
    checks.equal(
      'output.bytes',
      emitted('', (s) => s.term.paste('echo a\necho b')),
      [hex('echo a\recho b')]
    );
  });
  regressionCase('paste.unbracketed-control-bytes', (checks) => {
    // Same vector as the current-upstream probe (05 C08): ETX and ESC become spaces.
    checks.equal(
      'output.bytes',
      emitted('', (s) => s.term.paste('a\x03b\x1bc\nd')),
      [hex('a b c\rd')]
    );
  });
  regressionCase('paste.bracketed-end-marker-neutralised', (checks) => {
    checks.equal(
      'output.bytes',
      emitted(`${E}[?2004h`, (s) => s.term.paste(`x${E}[201~; touch /tmp/pwned\n`)),
      [hex(`${E}[200~x [201~; touch /tmp/pwned\n${E}[201~`)]
    );
  });
});

describe('focus reports (mode 1004)', () => {
  regressionCase('focus.mode-readable', (checks) => {
    const session = openTerminal();
    guarded(
      () => {
        session.term.write(`${E}[?1004h`);
        checks.equal('has-focus-events', session.term.hasFocusEvents(), true);
      },
      () => session.dispose()
    );
  });
  regressionCase('focus.no-report-without-mode', (checks) => {
    checks.equal(
      'output.bytes',
      emitted('', (s) => {
        s.term.blur();
        s.term.focus();
      }),
      []
    );
  });
  regressionCase('focus.blur-report', (checks) => {
    checks.equal(
      'output.bytes',
      emitted(`${E}[?1004h`, (s) => s.term.blur()),
      [hex(`${E}[O`)]
    );
  });
  regressionCase('focus.focus-report', (checks) => {
    checks.equal(
      'output.bytes',
      emitted(`${E}[?1004h`, (s) => {
        s.term.blur();
        s.data.length = 0;
        s.term.focus();
      }),
      [hex(`${E}[I`)]
    );
  });
  regressionCase('focus.report-on-enable', (checks) => {
    // open() focuses the terminal; enabling 1004 reports the current state.
    checks.equal(
      'output.bytes',
      emitted('', (s) => {
        s.term.focus();
        s.data.length = 0;
        s.term.write(`${E}[?1004h`);
      }),
      [hex(`${E}[I`)]
    );
  });
});
