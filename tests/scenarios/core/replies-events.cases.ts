/**
 * L1/L2: terminal replies (WEB-03, IN-11) and host-visible events.
 *
 * Reply expectations follow the core at the migration target (libghostty-vt
 * 8f0dd370, report 02 U01/05 C03) and ECMA-48/DEC/xterm definitions. Event
 * expectations follow xterm.js semantics where ghostty-web promises them
 * (onBell/onTitleChange/disableStdin), verified against @xterm/headless 5.5.
 */
import { describe, regressionCase } from '../../regression/core/harness/scenario';
import {
  type OpenOptions,
  type WebSession,
  guarded,
  hex,
  hexChunks,
  openTerminal,
} from '../../regression/core/harness/web';

const E = '\x1b';

function replies(input: string | Uint8Array, options: OpenOptions = {}): string[] {
  const session = openTerminal(options);
  return guarded(
    () => {
      session.term.write(input);
      return hexChunks(session.data);
    },
    () => session.dispose()
  );
}

function concat(chunks: string[]): string {
  return chunks.join('');
}

function withSession<T>(options: OpenOptions, body: (s: WebSession) => T): T {
  const session = openTerminal(options);
  return guarded(
    () => {
      return body(session);
    },
    () => session.dispose()
  );
}

describe('replies', () => {
  regressionCase('reply.none-for-plain-text', (checks) => {
    checks.equal('replies', replies('hello\r\nworld'), []);
  });
  regressionCase('reply.cpr-home', (checks) => {
    checks.equal('replies', replies(`${E}[6n`), [hex(`${E}[1;1R`)]);
  });
  regressionCase('reply.cpr-after-move', (checks) => {
    checks.equal('replies', replies(`${E}[3;5H${E}[6n`), [hex(`${E}[3;5R`)]);
  });
  regressionCase('reply.dsr-status', (checks) => {
    checks.equal('replies', replies(`${E}[5n`), [hex(`${E}[0n`)]);
  });
  regressionCase('reply.da1', (checks) => {
    // libghostty-vt default without OSC 52 support: VT220 + ANSI colour.
    checks.equal('replies', replies(`${E}[c`), [hex(`${E}[?62;22c`)]);
  });
  regressionCase('reply.order-preserved', (checks) => {
    checks.equal(
      'reply-bytes',
      concat(replies(`${E}[6n${E}[5n${E}[c`)),
      hex(`${E}[1;1R${E}[0n${E}[?62;22c`)
    );
  });
  regressionCase('reply.decrqm-2004-reset', (checks) => {
    checks.equal('replies', replies(`${E}[?2004$p`), [hex(`${E}[?2004;2$y`)]);
  });
  regressionCase('reply.decrqm-2004-set', (checks) => {
    checks.equal('replies', replies(`${E}[?2004h${E}[?2004$p`), [hex(`${E}[?2004;1$y`)]);
  });
  regressionCase('reply.decrqm-2026', (checks) => {
    checks.equal('replies', replies(`${E}[?2026$p`), [hex(`${E}[?2026;2$y`)]);
  });
  regressionCase('reply.kitty-keyboard-query', (checks) => {
    checks.equal('replies', replies(`${E}[?u`), [hex(`${E}[?0u`)]);
  });
  regressionCase('reply.xtversion-is-dcs', (checks) => {
    const reply = concat(replies(`${E}[>q`));
    checks.equal('dcs-prefix', reply.startsWith(hex(`${E}P>|`)), true);
  });
  regressionCase('reply.text-area-size-chars', (checks) => {
    checks.equal('replies', replies(`${E}[18t`, { cols: 20, rows: 4 }), [hex(`${E}[8;4;20t`)]);
  });
  regressionCase('reply.disable-stdin-suppresses-replies', (checks) => {
    // xterm.js routes replies through the same data event and drops them when stdin is disabled.
    checks.equal('replies', replies(`${E}[6n`, { disableStdin: true }), []);
  });
});

describe('events', () => {
  regressionCase('event.bell', (checks) => {
    withSession({}, (s) => {
      s.term.write('\x07');
      checks.equal('bells', s.bells, 1);
    });
  });
  regressionCase('event.bell-not-from-osc-terminator', (checks) => {
    withSession({}, (s) => {
      s.term.write(`${E}]0;hello\x07`);
      checks.equal('bells', s.bells, 0);
    });
  });
  regressionCase('event.bell-not-from-osc8-terminators', (checks) => {
    withSession({}, (s) => {
      s.term.write(`${E}]8;;https://a.example\x07link${E}]8;;\x07`);
      checks.equal('bells', s.bells, 0);
    });
  });
  regressionCase('event.title-string', (checks) => {
    withSession({}, (s) => {
      s.term.write(`${E}]2;hello\x07`);
      checks.equal('titles', s.titles, ['hello']);
    });
  });
  regressionCase('event.title-st-terminator', (checks) => {
    withSession({}, (s) => {
      s.term.write(`${E}]0;with st${E}\\`);
      checks.equal('titles', s.titles, ['with st']);
    });
  });
  regressionCase('event.title-uint8array', (checks) => {
    withSession({}, (s) => {
      s.term.write(new TextEncoder().encode(`${E}]2;bytes\x07`));
      checks.equal('titles', s.titles, ['bytes']);
    });
  });
  regressionCase('event.title-split-across-writes', (checks) => {
    withSession({}, (s) => {
      s.term.write(`${E}]2;sp`);
      s.term.write(`lit${E}\\`);
      checks.equal('titles', s.titles, ['split']);
    });
  });
  regressionCase('event.input-was-user-input', (checks) => {
    withSession({}, (s) => {
      s.term.input('x', true);
      s.term.input('y', false);
      checks.equal('on-data', hexChunks(s.data), ['78']);
    });
  });
});
