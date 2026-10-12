/**
 * Dedicated reference-engine cases: byte-exact replies, effects, modes, reset, graphemes,
 * wrap flags, scrollback, resize and lifecycle. Expected values come from the cited protocol
 * spec or upstream Ghostty test at the pinned commit — never from ghostty-web output.
 */
import assert from 'node:assert/strict';
import type { ProvenanceKind } from './corpus';
import { rowText } from './corpus';
import type { ReferenceInstance, ReferenceTerminal } from './loader';

/**
 * The upstream commit every citation below (file + line + test name) was verified
 * against. This is the lane's explicit oracle status, deliberately separate from
 * the build pin in ghostty-build.json: the runner refuses to run when the pin moves
 * until the oracles are re-verified at the new commit and this constant is updated.
 */
export const ORACLE_COMMIT = '246f702876b924a1cb7cade1e99274d1470302fc';

export interface Provenance {
  kind: ProvenanceKind;
  reference: string;
}

export interface CaseContext {
  /** Runs `fn` on a fresh WASM instance (fresh linear memory), disposed afterwards. */
  fresh<T>(fn: (vt: ReferenceInstance) => T): T;
  /** Fresh instance + one terminal of the given size. */
  term<T>(cols: number, rows: number, fn: (t: ReferenceTerminal) => T): T;
}

export interface ReferenceCase {
  name: string;
  provenance: Provenance;
  run(ctx: CaseContext): void;
}

/** Permalink to an upstream test at the pinned commit. */
const upstream = (path: string, line: number, test: string): Provenance => ({
  kind: 'upstream-test',
  reference: `https://github.com/ghostty-org/ghostty/blob/${ORACLE_COMMIT}/${path}#L${line} (test "${test}")`,
});
const header = (path: string, what: string): Provenance => ({
  kind: 'spec',
  reference: `ghostty@${ORACLE_COMMIT.slice(0, 12)} ${path}: ${what}`,
});
const spec = (reference: string): Provenance => ({ kind: 'spec', reference });
const invariant = (reference: string): Provenance => ({ kind: 'invariant', reference });

const ST = '\x1b\\';
const decoder = new TextDecoder();

/** Writes `input` and returns all write_pty bytes it produced, concatenated (as text). */
function reply(t: ReferenceTerminal, input: string): string {
  t.takeEffects();
  t.write(input);
  return t
    .takeEffects()
    .replies.map((r) => decoder.decode(r))
    .join('');
}

function lines(t: ReferenceTerminal, tag: 'ACTIVE' | 'VIEWPORT' = 'ACTIVE'): string[] {
  const { rows } = t.size();
  return Array.from({ length: rows }, (_, y) => rowText(t.row(tag, y)));
}

const DEC_MODES = [1, 7, 25, 1000, 1002, 1003, 1004, 1006, 1049, 2004, 2026, 2027] as const;
const DEC_DEFAULT_ON = new Set<number>([7, 25]);

function assertDefaultModes(t: ReferenceTerminal, label: string): void {
  for (const mode of DEC_MODES) {
    assert.equal(t.getMode(mode), DEC_DEFAULT_ON.has(mode), `${label}: DEC mode ${mode}`);
  }
  assert.equal(t.getMode(4, true), false, `${label}: ANSI IRM`);
  assert.equal(t.getMode(20, true), false, `${label}: ANSI LNM`);
}

const ZWJ_FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

export const CASES: ReferenceCase[] = [
  // ---------------------------------------------------------------- replies
  {
    name: 'reply.dsr-operating-status',
    provenance: upstream(
      'src/terminal/stream_terminal.zig',
      6125,
      'device status: operating status'
    ),
    run: (c) => c.term(80, 24, (t) => assert.equal(reply(t, '\x1b[5n'), '\x1b[0n')),
  },
  {
    name: 'reply.dsr-cursor-position',
    provenance: upstream(
      'src/terminal/stream_terminal.zig',
      6150,
      'device status: cursor position'
    ),
    run: (c) =>
      c.term(80, 24, (t) => {
        assert.equal(reply(t, '\x1b[6n'), '\x1b[1;1R');
        assert.equal(reply(t, '\x1b[5;10H\x1b[6n'), '\x1b[5;10R');
      }),
  },
  {
    name: 'reply.dsr-cursor-position-origin-mode',
    provenance: upstream(
      'src/terminal/stream_terminal.zig',
      6180,
      'device status: cursor position with origin mode'
    ),
    run: (c) =>
      c.term(80, 24, (t) =>
        assert.equal(reply(t, '\x1b[5;20r\x1b[?6h\x1b[3;5H\x1b[6n'), '\x1b[3;5R')
      ),
  },
  {
    name: 'reply.da1-default',
    provenance: upstream(
      'src/terminal/c/terminal.zig',
      6343,
      'device_attributes without callback uses default'
    ),
    run: (c) => c.term(80, 24, (t) => assert.equal(reply(t, '\x1b[c'), '\x1b[?62;22c')),
  },
  {
    name: 'reply.da2-default',
    provenance: upstream('src/terminal/device_attributes.zig', 208, 'secondary default'),
    run: (c) => c.term(80, 24, (t) => assert.equal(reply(t, '\x1b[>c'), '\x1b[>1;0;0c')),
  },
  {
    name: 'reply.xtversion-default',
    provenance: upstream(
      'src/terminal/c/terminal.zig',
      4610,
      'xtversion without callback reports default'
    ),
    run: (c) => c.term(80, 24, (t) => assert.equal(reply(t, '\x1b[>q'), `\x1bP>|libghostty${ST}`)),
  },
  {
    name: 'reply.kitty-keyboard-query',
    provenance: upstream('src/terminal/stream_terminal.zig', 5611, 'kitty_keyboard_query'),
    run: (c) =>
      c.term(80, 24, (t) => {
        assert.equal(reply(t, '\x1b[?u'), '\x1b[?0u');
        assert.equal(reply(t, '\x1b[>1u\x1b[?u'), '\x1b[?1u');
      }),
  },
  {
    name: 'reply.decrqm-dec-private',
    provenance: upstream(
      'src/terminal/stream_terminal.zig',
      5365,
      'request mode DECRQM with write_pty callback'
    ),
    run: (c) =>
      c.term(80, 24, (t) => {
        assert.equal(reply(t, '\x1b[?7$p'), '\x1b[?7;1$y');
        assert.equal(reply(t, '\x1b[?7l\x1b[?7$p'), '\x1b[?7;2$y');
        assert.equal(reply(t, '\x1b[?32775$p'), '\x1b[?32775;0$y');
        assert.equal(reply(t, '\x1b[?9999$p'), '\x1b[?9999;0$y');
        assert.equal(reply(t, '\x1b[?117$p'), '\x1b[?117;4$y');
      }),
  },
  {
    name: 'reply.decrqm-ansi',
    provenance: upstream(
      'src/terminal/stream_terminal.zig',
      5424,
      'request mode DECRQM ANSI responses'
    ),
    run: (c) =>
      c.term(80, 24, (t) => {
        assert.equal(reply(t, '\x1b[4$p'), '\x1b[4;2$y');
        assert.equal(reply(t, '\x1b[4h\x1b[4$p'), '\x1b[4;1$y');
        assert.equal(reply(t, '\x1b[20h\x1b[20$p'), '\x1b[20;1$y');
      }),
  },
  {
    name: 'reply.decrqm-synchronized-output-2026',
    provenance: spec(
      'Synchronized output (mode 2026) spec: DECRQM ?2026 reports 1=set / 2=reset (findings WEB-03, L12)'
    ),
    run: (c) =>
      c.term(80, 24, (t) => {
        assert.equal(reply(t, '\x1b[?2026$p'), '\x1b[?2026;2$y');
        assert.equal(reply(t, '\x1b[?2026h\x1b[?2026$p'), '\x1b[?2026;1$y');
        assert.equal(reply(t, '\x1b[?2026l\x1b[?2026$p'), '\x1b[?2026;2$y');
      }),
  },
  {
    name: 'reply.osc-color-queries',
    provenance: upstream('src/terminal/stream_terminal.zig', 3396, 'OSC color query responses'),
    run: (c) =>
      c.term(10, 10, (t) => {
        assert.equal(reply(t, `\x1b]10;?${ST}`), '', 'no default foreground configured');
        assert.equal(reply(t, `\x1b]11;?${ST}`), '', 'no default background configured');
        assert.equal(
          reply(t, `\x1b]4;2;rgb:12/34/56;2;?${ST}`),
          `\x1b]4;2;rgb:1212/3434/5656${ST}`
        );
        t.write(`\x1b]10;rgb:01/02/03${ST}\x1b]11;rgb:04/05/06${ST}\x1b]12;rgb:07/08/09${ST}`);
        assert.equal(
          reply(t, `\x1b]10;?;?;?${ST}`),
          `\x1b]10;rgb:0101/0202/0303${ST}\x1b]11;rgb:0404/0505/0606${ST}\x1b]12;rgb:0707/0808/0909${ST}`
        );
        assert.equal(reply(t, `\x1b]112${ST}\x1b]12;?\x07`), '\x1b]12;rgb:0101/0202/0303\x07');
      }),
  },
  {
    name: 'reply.order-within-one-write',
    provenance: invariant('replies are emitted in stimulus order within one write (finding V-04)'),
    run: (c) =>
      c.term(80, 24, (t) =>
        assert.equal(reply(t, '\x1b[5n\x1b[6n\x1b[c'), '\x1b[0n\x1b[1;1R\x1b[?62;22c')
      ),
  },
  {
    name: 'reply.none-for-text-and-sgr',
    provenance: invariant(
      'negative control: printable text, SGR and cursor motion produce no PTY output'
    ),
    run: (c) => c.term(10, 2, (t) => assert.equal(reply(t, 'abc\x1b[1;31mX\x1b[0m\x1b[H\r\n'), '')),
  },

  // ---------------------------------------------------------------- effects
  {
    name: 'effect.bell',
    provenance: upstream('src/terminal/stream_terminal.zig', 3731, 'bell effect callback'),
    run: (c) =>
      c.term(20, 2, (t) => {
        t.write('\x07AfterBell');
        const fx = t.takeEffects();
        assert.equal(fx.bells, 1);
        assert.deepEqual(lines(t), ['AfterBell', '']);
      }),
  },
  {
    name: 'effect.title-osc2',
    provenance: upstream('src/terminal/stream_terminal.zig', 5499, 'window_title effect is called'),
    run: (c) =>
      c.term(80, 24, (t) => {
        t.write(`\x1b]2;Hello World${ST}`);
        assert.equal(t.title(), 'Hello World');
        assert.equal(t.takeEffects().titleChanges, 1);
      }),
  },
  {
    name: 'effect.title-osc0-bel-terminated-is-not-a-bell',
    provenance: spec('xterm ctlseqs: OSC Ps ; Pt BEL — BEL terminates the OSC (no bell)'),
    run: (c) =>
      c.term(80, 24, (t) => {
        t.write('\x1b]0;hello\x07');
        const fx = t.takeEffects();
        assert.equal(t.title(), 'hello');
        assert.equal(fx.titleChanges, 1);
        assert.equal(fx.bells, 0);
      }),
  },
  {
    name: 'effect.title-fragmented-bytewise',
    provenance: invariant('write fragmentation must not change effects (findings L11, IN-10)'),
    run: (c) =>
      c.term(80, 24, (t) => {
        const bytes = new TextEncoder().encode(`\x1b]2;bin\u00e4ry \u4e00${ST}`);
        for (const b of bytes) t.write(Uint8Array.of(b));
        assert.equal(t.title(), 'bin\u00e4ry \u4e00');
        assert.equal(t.takeEffects().titleChanges, 1);
      }),
  },
  {
    name: 'effect.pwd-osc7',
    provenance: upstream('src/terminal/c/terminal.zig', 5379, 'set pwd_changed callback'),
    run: (c) =>
      c.term(80, 24, (t) => {
        t.write(`\x1b]7;file:///tmp${ST}`);
        assert.equal(t.pwd(), 'file:///tmp');
        t.write(`\x1b]7;file:///home/user${ST}`);
        assert.equal(t.pwd(), 'file:///home/user');
        assert.equal(t.takeEffects().pwdChanges, 2);
      }),
  },
  {
    name: 'effect.clipboard-osc52',
    provenance: upstream(
      'src/terminal/stream_terminal.zig',
      4149,
      'clipboard_write effect callback'
    ),
    run: (c) =>
      c.term(80, 24, (t) => {
        const cases: [string, string, string][] = [
          [`\x1b]52;c;aGVsbG8=${ST}`, 'standard', 'hello'],
          ['\x1b]52;s;d29ybGQ=\x07', 'selection', 'world'],
          [`\x1b]52;p;cHJpbWFyeQ==${ST}`, 'primary', 'primary'],
          [`\x1b]52;0;Y3V0${ST}`, 'standard', 'cut'],
          [`\x1b]52;x;ZmFsbGJhY2s=${ST}`, 'standard', 'fallback'],
          [`\x1b]52;c;YQBi${ST}`, 'standard', 'a\x00b'],
          [`\x1b]52;c;dW5wYWRkZWQ${ST}`, 'standard', 'unpadded'],
        ];
        for (const [input, location, data] of cases) {
          t.write(input);
          const writes = t.takeEffects().clipboardWrites;
          assert.equal(writes.length, 1, JSON.stringify(input));
          assert.equal(writes[0].location, location, JSON.stringify(input));
          assert.deepEqual(
            writes[0].contents.map((x) => [x.mime, decoder.decode(x.data)]),
            [['text/plain', data]],
            JSON.stringify(input)
          );
        }
        t.write(`\x1b]52;s;${ST}`);
        const clear = t.takeEffects().clipboardWrites;
        assert.deepEqual(
          clear.map((w) => [w.location, w.contents.length]),
          [['selection', 0]],
          'empty payload clears'
        );
        for (const ignored of ['?', '***', 'SGVs!!!bG8=', 'aGVs bG8=']) {
          t.write(`\x1b]52;c;${ignored}${ST}`);
        }
        assert.equal(
          t.takeEffects().clipboardWrites.length,
          0,
          'reads and malformed base64 ignored'
        );
        t.write('\x1b]52;p;ZnJh');
        t.write('Z21lbnRlZA==\x1b');
        t.write('\\');
        const fragmented = t.takeEffects().clipboardWrites;
        assert.equal(fragmented.length, 1);
        assert.equal(decoder.decode(fragmented[0].contents[0].data), 'fragmented');
      }),
  },
  {
    name: 'effect.hyperlink-osc8',
    provenance: spec(
      'OSC 8 hyperlinks (egmontkob/eaf16d4d): cells printed between open/close carry the URI'
    ),
    run: (c) =>
      c.term(10, 1, (t) => {
        t.write(`\x1b]8;;https://example.com/a${ST}link\x1b]8;;${ST}x`);
        for (let x = 0; x < 4; x++)
          assert.equal(t.hyperlinkUri('ACTIVE', x, 0), 'https://example.com/a');
        assert.equal(t.hyperlinkUri('ACTIVE', 4, 0), '');
        assert.deepEqual(lines(t), ['linkx']);
      }),
  },

  // ---------------------------------------------------------------- modes
  {
    name: 'mode.defaults',
    provenance: header(
      'src/terminal/modes.zig',
      'mode table defaults — wraparound (L350) and cursor_visible (L354) default true, the rest false'
    ),
    run: (c) =>
      c.term(10, 2, (t) => {
        assertDefaultModes(t, 'initial');
        assert.equal(t.activeScreen(), 'primary');
      }),
  },
  {
    name: 'mode.decset-decrst-roundtrip',
    provenance: spec('DEC private modes set/reset by CSI ? Pm h / CSI ? Pm l (xterm ctlseqs)'),
    run: (c) =>
      c.term(10, 2, (t) => {
        for (const mode of DEC_MODES) {
          t.write(`\x1b[?${mode}h`);
          assert.equal(t.getMode(mode), true, `?${mode}h`);
          if (mode === 1049) assert.equal(t.activeScreen(), 'alternate');
          t.write(`\x1b[?${mode}l`);
          assert.equal(t.getMode(mode), false, `?${mode}l`);
          if (mode === 1049) assert.equal(t.activeScreen(), 'primary');
        }
      }),
  },
  {
    name: 'mode.lnm-linefeed-implies-cr',
    provenance: spec('ECMA-48 LNM (ANSI mode 20): LF also performs CR'),
    run: (c) =>
      c.term(10, 2, (t) => {
        t.write('\x1b[20hab\ncd');
        assert.equal(t.getMode(20, true), true);
        assert.deepEqual(lines(t), ['ab', 'cd']);
        assert.deepEqual([t.cursor().x, t.cursor().y], [2, 1]);
      }),
  },

  // ---------------------------------------------------------------- reset
  {
    name: 'reset.ris-restores-initial-state',
    provenance: header(
      'include/ghostty/vt/terminal.h',
      'ghostty_terminal_reset — full reset (RIS) of modes, scrollback, scrolling region and screen'
    ),
    run: (c) => {
      for (const via of ['ESC c', 'ghostty_terminal_reset'] as const) {
        c.term(10, 3, (t) => {
          t.write('one\r\ntwo\r\nthree\r\nfour\r\nfive');
          assert.ok(t.scrollbackRows() > 0, 'precondition: history exists');
          t.write('\x1b[?2004h\x1b[?25l\x1b[?1h\x1b[4h\x1b[2;3r\x1b[1;31m\x1b[?1049halt');
          assert.equal(t.activeScreen(), 'alternate', 'precondition: alternate screen');
          if (via === 'ESC c') t.write('\x1bc');
          else t.reset();
          assertDefaultModes(t, via);
          assert.equal(t.activeScreen(), 'primary', via);
          assert.deepEqual(lines(t), ['', '', ''], via);
          assert.deepEqual(t.cursor(), { x: 0, y: 0, pendingWrap: false, visible: true }, via);
          assert.equal(t.scrollbackRows(), 0, via);
          t.write('a\r\nb\r\nc\r\nd'); // full-height scroll region again
          assert.deepEqual(lines(t), ['b', 'c', 'd'], `${via}: scroll region reset`);
        });
      }
    },
  },
  {
    name: 'reset.mode-default-survives-ris',
    provenance: upstream('src/terminal/Terminal.zig', 16065, 'Terminal: fullReset default modes'),
    run: (c) =>
      c.term(10, 2, (t) => {
        t.setMode(2027, true, { asDefault: true });
        t.write('\x1b[?2027l\x1bc');
        assert.equal(t.getMode(2027), true);
        t.write(ZWJ_FAMILY);
        assert.equal(t.cursor().x, 2, 'grapheme clustering active after RIS');
      }),
  },

  // ---------------------------------------------------------------- DECSTR (soft reset, CSI ! p)
  // Implemented upstream in f473f3109 (after 0f171f65); these prove the pinned
  // engine runs the new path rather than ignoring the sequence.
  {
    name: 'reset.decstr-resets-its-modes-only',
    provenance: upstream('src/terminal/Terminal.zig', 16110, 'Terminal: softReset modes'),
    run: (c) =>
      c.term(10, 10, (t) => {
        t.write('\x1b[4h\x1b[?6h\x1b[?7l\x1b[?45h\x1b[?25l\x1b[?1h\x1b[?66h\x1b[?2004h');
        const set = { 4: true, 6: true, 7: false, 45: true, 25: false, 1: true, 66: true };
        for (const [mode, value] of Object.entries(set)) {
          const ansi = mode === '4';
          assert.equal(t.getMode(Number(mode), ansi), value, `precondition: mode ${mode}`);
        }
        t.write('\x1b[!p');
        assert.equal(t.getMode(4, true), false, 'IRM reset');
        assert.equal(t.getMode(6), false, 'DECOM reset');
        assert.equal(t.getMode(7), true, 'DECAWM back to default on');
        assert.equal(t.getMode(45), false, 'reverse wrap reset');
        assert.equal(t.getMode(25), true, 'DECTCEM back to default on');
        assert.equal(t.getMode(1), false, 'DECCKM reset');
        assert.equal(t.getMode(66), false, 'DECNKM reset');
        assert.equal(t.getMode(2004), true, 'modes DECSTR does not cover are kept');
      }),
  },
  {
    name: 'reset.decstr-resets-scrolling-margins',
    provenance: upstream('src/terminal/Terminal.zig', 16136, 'Terminal: softReset margins'),
    run: (c) => {
      // LF on the last row only scrolls when the full-screen region is restored.
      const setup = 'A\r\nB\r\nC\r\nD\x1b[2;3r\x1b[?69h\x1b[2;4s';
      c.term(5, 4, (t) => {
        t.write(`${setup}\x1b[4;1H\n`);
        assert.deepEqual(lines(t), ['A', 'B', 'C', 'D'], 'control: region 2-3 is active');
      });
      c.term(5, 4, (t) => {
        t.write(`${setup}\x1b[!p`);
        assert.equal(t.getMode(69), false, 'DECLRMM reset');
        t.write('\x1b[4;1H\n');
        assert.deepEqual(lines(t), ['B', 'C', 'D', ''], 'full-screen region after DECSTR');
      });
    },
  },
  {
    name: 'reset.decstr-keeps-cursor-and-screen',
    provenance: upstream(
      'src/terminal/Terminal.zig',
      16154,
      'Terminal: softReset keeps the cursor and screen'
    ),
    run: (c) =>
      c.term(10, 10, (t) => {
        t.write('\x1b]2;kept\x1b\\hello\x1b[6;5H\x1b[!p');
        assert.deepEqual([t.cursor().x, t.cursor().y], [4, 5]);
        assert.equal(t.formatPlain({ unwrap: false, trim: true }), 'hello');
        assert.equal(t.title(), 'kept', 'title kept (terminal.h: soft reset keeps the title)');
      }),
  },
  {
    name: 'reset.decstr-clears-saved-cursor',
    provenance: upstream('src/terminal/Terminal.zig', 16170, 'Terminal: softReset saved cursor'),
    run: (c) =>
      c.term(10, 10, (t) => {
        t.write('\x1b[6;5H\x1b7\x1b[!p\x1b8');
        assert.deepEqual([t.cursor().x, t.cursor().y], [0, 0]);
      }),
  },
  {
    name: 'reset.decstr-resets-charsets',
    provenance: upstream(
      'src/terminal/Terminal.zig',
      16185,
      'Terminal: softReset pen, protection, and charsets'
    ),
    run: (c) =>
      c.term(10, 1, (t) => {
        t.write('\x1b(0q\x1b[!pq');
        assert.deepEqual(lines(t), ['\u2500q'], 'G0 DEC special graphics, then UTF-8 again');
      }),
  },
  {
    name: 'reset.decstr-needs-the-exact-sequence',
    provenance: upstream('src/terminal/stream.zig', 3536, 'stream: DECSTR dispatch'),
    run: (c) =>
      c.term(10, 1, (t) => {
        t.write('\x1b[4h\x1b[1!p\x1b[?!p\x1b[$p');
        assert.equal(t.getMode(4, true), true, 'CSI 1 ! p, CSI ? ! p and CSI $ p are not DECSTR');
        t.write('\x1b[!p');
        assert.equal(t.getMode(4, true), false);
      }),
  },
  {
    name: 'formatter.vt-replay-keeps-origin-mode-cursor',
    provenance: upstream(
      'src/terminal/formatter.zig',
      5668,
      'Terminal vt with cursor in origin mode'
    ),
    run: (c) => {
      // Upstream 23c7a3e5a: in origin mode the CUP is relative to the region.
      const streams = [
        '\x1b[3;8r\x1b[?6h\x1b[2;5H',
        '\x1b[?69h\x1b[3;8r\x1b[4;15s\x1b[?6h\x1b[2;3H',
        '\x1b[3;8r\x1b[?6h\x1b[2;20Hx',
      ];
      for (const stream of streams) {
        const [want, replay] = c.fresh((vt) => {
          const t = vt.createTerminal(20, 10);
          t.write(stream);
          return [t.cursor(), t.formatVtWithAllExtras()] as const;
        });
        c.term(20, 10, (t2) => {
          t2.write(replay);
          assert.equal(t2.getMode(6), true, `origin mode replayed for ${JSON.stringify(stream)}`);
          assert.deepEqual(t2.cursor(), want, `cursor replayed for ${JSON.stringify(stream)}`);
        });
      }
    },
  },

  // ---------------------------------------------------------------- graphemes / width
  {
    name: 'grapheme.wide-char',
    provenance: upstream('src/terminal/Terminal.zig', 5288, 'Terminal: print wide char'),
    run: (c) =>
      c.term(80, 80, (t) => {
        t.write('\u{1F600}');
        assert.deepEqual([t.cursor().x, t.cursor().y], [2, 0]);
        const row = t.row('ACTIVE', 0);
        assert.deepEqual(row.cells[0].codepoints, [0x1f600]);
        assert.equal(row.cells[0].wide, 'wide');
        assert.equal(row.cells[1].wide, 'spacer_tail');
        assert.equal(rowText(row), '\u{1F600}', 'spacer tail is not rendered as a space');
      }),
  },
  {
    name: 'grapheme.wide-char-at-edge-spacer-head',
    provenance: upstream(
      'src/terminal/Terminal.zig',
      5311,
      'Terminal: print wide char at edge creates spacer head'
    ),
    run: (c) =>
      c.term(10, 10, (t) => {
        t.write('\x1b[1;10H\u{1F600}');
        assert.deepEqual([t.cursor().x, t.cursor().y], [2, 1]);
        assert.equal(t.row('ACTIVE', 0).cells[9].wide, 'spacer_head');
        const row1 = t.row('ACTIVE', 1);
        assert.deepEqual(row1.cells[0].codepoints, [0x1f600]);
        assert.equal(row1.cells[0].wide, 'wide');
        assert.equal(row1.cells[1].wide, 'spacer_tail');
      }),
  },
  {
    name: 'grapheme.zwj-family-mode-2027-off',
    provenance: upstream(
      'src/terminal/Terminal.zig',
      5529,
      'Terminal: print multicodepoint grapheme, disabled mode 2027'
    ),
    run: (c) =>
      c.term(80, 80, (t) => {
        t.write(ZWJ_FAMILY);
        assert.deepEqual([t.cursor().x, t.cursor().y], [6, 0]);
        const cells = t.row('ACTIVE', 0).cells;
        assert.deepEqual(
          cells.slice(0, 6).map((cell) => cell.wide),
          ['wide', 'spacer_tail', 'wide', 'spacer_tail', 'wide', 'spacer_tail']
        );
        assert.deepEqual(cells[0].codepoints, [0x1f468, 0x200d]);
        assert.deepEqual(cells[2].codepoints, [0x1f469, 0x200d]);
        assert.equal(cells[4].codepoints[0], 0x1f467);
      }),
  },
  {
    name: 'grapheme.zwj-family-mode-2027-on',
    provenance: upstream(
      'src/terminal/Terminal.zig',
      5761,
      'Terminal: print multicodepoint grapheme, mode 2027'
    ),
    run: (c) =>
      c.term(80, 80, (t) => {
        t.write(`\x1b[?2027h${ZWJ_FAMILY}`);
        assert.deepEqual([t.cursor().x, t.cursor().y], [2, 0]);
        const cells = t.row('ACTIVE', 0).cells;
        assert.equal(cells[0].wide, 'wide');
        assert.deepEqual(cells[0].codepoints, [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467]);
        assert.equal(cells[1].wide, 'spacer_tail');
        assert.deepEqual(cells[1].codepoints, []);
      }),
  },
  {
    name: 'grapheme.combining-mark-attaches',
    provenance: spec('Unicode: U+0301 is a zero-width combining mark and joins the preceding cell'),
    run: (c) =>
      c.term(10, 1, (t) => {
        t.write('e\u0301x');
        const cells = t.row('ACTIVE', 0).cells;
        assert.deepEqual(cells[0].codepoints, [0x65, 0x301]);
        assert.deepEqual(cells[1].codepoints, [0x78]);
        assert.equal(t.cursor().x, 2);
      }),
  },
  {
    name: 'grapheme.zero-width-attaches-to-pending-wrap-cell',
    provenance: upstream(
      'src/terminal/Terminal.zig',
      5239,
      'Terminal: zero-width character attaches to pending wrap cell'
    ),
    run: (c) =>
      c.term(2, 2, (t) => {
        t.write('\x1b[?2027lx\u00e5\u0332');
        assert.equal(t.formatPlain({ unwrap: false, trim: true }), 'x\u00e5\u0332');
        assert.deepEqual(t.row('ACTIVE', 0).cells[1].codepoints, [0xe5, 0x332]);
        assert.deepEqual(t.cursor(), { x: 1, y: 0, pendingWrap: true, visible: true });
      }),
  },
  {
    name: 'grapheme.zero-width-at-start-ignored',
    provenance: upstream(
      'src/terminal/Terminal.zig',
      5223,
      'Terminal: zero-width character at start'
    ),
    run: (c) =>
      c.term(80, 80, (t) => {
        t.write('\u200d');
        assert.deepEqual([t.cursor().x, t.cursor().y], [0, 0]);
        assert.equal(rowText(t.row('ACTIVE', 0)), '');
      }),
  },
  {
    name: 'grapheme.preserved-in-scrollback',
    provenance: invariant(
      'rows scrolled into history keep their grapheme clusters (finding WEB-09)'
    ),
    run: (c) =>
      c.term(20, 5, (t) => {
        t.write('e\u0301 grapheme\r\n');
        for (let i = 0; i < 10; i++) t.write(`line${i}\r\n`);
        assert.ok(t.scrollbackRows() >= 1);
        const row = t.row('HISTORY', 0);
        assert.deepEqual(row.cells[0].codepoints, [0x65, 0x301]);
        assert.equal(rowText(row), 'e\u0301 grapheme');
      }),
  },

  // ---------------------------------------------------------------- wrap flags
  {
    name: 'wrap.soft-wrap-flags-and-unwrap',
    provenance: upstream('src/terminal/Terminal.zig', 7174, 'Terminal: soft wrap'),
    run: (c) =>
      c.term(3, 4, (t) => {
        t.write('hello');
        assert.deepEqual([t.cursor().x, t.cursor().y], [2, 1]);
        const [r0, r1] = [t.row('ACTIVE', 0), t.row('ACTIVE', 1)];
        assert.deepEqual([rowText(r0), r0.wrap, r0.wrapContinuation], ['hel', true, false]);
        assert.deepEqual([rowText(r1), r1.wrap, r1.wrapContinuation], ['lo', false, true]);
        assert.equal(t.formatPlain({ unwrap: false, trim: true }), 'hel\nlo');
        assert.equal(t.formatPlain({ unwrap: true, trim: true }), 'hello');
      }),
  },
  {
    name: 'wrap.hard-newline-has-no-wrap-flags',
    provenance: spec('CR LF is a hard line break; only autowrap sets the soft-wrap row flag'),
    run: (c) =>
      c.term(3, 4, (t) => {
        t.write('hel\r\nlo');
        const [r0, r1] = [t.row('ACTIVE', 0), t.row('ACTIVE', 1)];
        assert.deepEqual(
          [r0.wrap, r0.wrapContinuation, r1.wrap, r1.wrapContinuation],
          [false, false, false, false]
        );
        assert.equal(t.formatPlain({ unwrap: true, trim: true }), 'hel\nlo');
      }),
  },
  {
    name: 'wrap.pending-wrap-sets-flag-only-when-taken',
    provenance: spec(
      'DEC autowrap: printing in the last column sets pending wrap; the next printable wraps'
    ),
    run: (c) =>
      c.term(3, 2, (t) => {
        t.write('abc');
        assert.deepEqual(t.cursor(), { x: 2, y: 0, pendingWrap: true, visible: true });
        assert.equal(t.row('ACTIVE', 0).wrap, false);
        t.write('d');
        assert.equal(t.row('ACTIVE', 0).wrap, true);
        assert.deepEqual(lines(t), ['abc', 'd']);
      }),
  },
  {
    name: 'wrap.flags-survive-into-scrollback',
    provenance: invariant(
      'soft-wrap/continuation flags are row state and survive scrolling into history'
    ),
    run: (c) =>
      c.term(5, 2, (t) => {
        t.write('abcdefghij\r\n1\r\n2\r\n3');
        const h0 = t.row('HISTORY', 0);
        const h1 = t.row('HISTORY', 1);
        assert.deepEqual([rowText(h0), h0.wrap, h0.wrapContinuation], ['abcde', true, false]);
        assert.deepEqual([rowText(h1), h1.wrap, h1.wrapContinuation], ['fghij', false, true]);
        assert.equal(t.formatPlain({ unwrap: true, trim: true }), 'abcdefghij\n1\n2\n3');
      }),
  },

  // ---------------------------------------------------------------- scrollback
  {
    name: 'scrollback.rows-retained-in-order',
    provenance: spec(
      'lines scrolled off the top of the primary screen enter scrollback in order (finding WEB-02)'
    ),
    run: (c) =>
      c.term(10, 5, (t) => {
        t.write(Array.from({ length: 12 }, (_, i) => `line${i}`).join('\r\n'));
        assert.equal(t.scrollbackRows(), 7);
        assert.equal(t.totalRows(), 12);
        for (let y = 0; y < 7; y++) assert.equal(rowText(t.row('HISTORY', y)), `line${y}`);
        // Bounds come from SCROLLBACK_ROWS/TOTAL_ROWS. (Triaged: at this commit a HISTORY point
        // past the scrollback resolves into the active area despite point.h's "history only"
        // wording, so HISTORY resolution is deliberately not used as a bound.)
        assert.equal(t.hasRow('SCREEN', 11), true);
        assert.equal(t.hasRow('SCREEN', 12), false, 'screen ends at TOTAL_ROWS');
        assert.deepEqual(lines(t), ['line7', 'line8', 'line9', 'line10', 'line11']);
      }),
  },
  {
    name: 'scrollback.viewport-scrolling',
    provenance: header(
      'include/ghostty/vt/terminal.h',
      'ghostty_terminal_scroll_viewport TOP/DELTA/BOTTOM'
    ),
    run: (c) =>
      c.term(10, 5, (t) => {
        t.write(Array.from({ length: 12 }, (_, i) => `line${i}`).join('\r\n'));
        t.scrollViewport('TOP');
        assert.equal(t.viewportActive(), false);
        assert.deepEqual(lines(t, 'VIEWPORT'), ['line0', 'line1', 'line2', 'line3', 'line4']);
        t.scrollViewport('DELTA', 1);
        assert.deepEqual(lines(t, 'VIEWPORT'), ['line1', 'line2', 'line3', 'line4', 'line5']);
        t.scrollViewport('BOTTOM');
        assert.equal(t.viewportActive(), true);
        assert.deepEqual(lines(t, 'VIEWPORT'), lines(t, 'ACTIVE'));
      }),
  },
  {
    name: 'scrollback.max-bytes-zero-disables',
    provenance: header(
      'include/ghostty/vt/terminal.h',
      'OPT_SCROLLBACK_MAX_BYTES: zero disables scrollback and erases history'
    ),
    run: (c) =>
      c.term(10, 3, (t) => {
        t.write('a\r\nb\r\nc\r\nd\r\ne');
        assert.ok(t.scrollbackRows() > 0, 'precondition: history exists');
        t.setSizeOption('SCROLLBACK_MAX_BYTES', 0);
        assert.equal(t.scrollbackRows(), 0);
        t.write('\r\nf\r\ng');
        assert.equal(t.scrollbackRows(), 0);
        assert.deepEqual(lines(t), ['e', 'f', 'g']);
      }),
  },
  {
    name: 'scrollback.unlimited-retains-all-across-memory-growth',
    provenance: header(
      'include/ghostty/vt/{terminal,wasm}.h',
      'NULL scrollback limits remove the limits; memory growth must not invalidate host reads'
    ),
    run: (c) =>
      c.fresh((vt) => {
        const t = vt.createTerminal(80, 24);
        t.setSizeOption('SCROLLBACK_MAX_BYTES', null);
        t.setSizeOption('SCROLLBACK_MAX_LINES', null);
        const before = vt.exports.memory.buffer.byteLength;
        const total = 3000;
        for (let i = 0; i < total; i += 500) {
          t.write(Array.from({ length: 500 }, (_, j) => `line ${i + j}\r\n`).join(''));
        }
        assert.ok(vt.exports.memory.buffer.byteLength > before, 'precondition: linear memory grew');
        assert.equal(t.scrollbackRows(), total + 1 - 24);
        assert.equal(rowText(t.row('HISTORY', 0)), 'line 0');
        assert.equal(rowText(t.row('HISTORY', total - 24)), `line ${total - 24}`);
        assert.equal(rowText(t.row('ACTIVE', 22)), `line ${total - 1}`);
      }),
  },

  // ---------------------------------------------------------------- resize
  {
    name: 'resize.narrowing-cuts-orphaned-wide-head',
    provenance: upstream(
      'src/terminal/Terminal.zig',
      16246,
      'Terminal: resize less cols without reflow cutting wide char tail'
    ),
    run: (c) =>
      c.term(3, 1, (t) => {
        t.write('a\u4e00\x1b[?7l');
        t.resize(2, 1);
        const cell = t.row('ACTIVE', 0).cells[1];
        assert.deepEqual(
          [cell.codepoints, cell.wide],
          [[], 'narrow'],
          'orphaned head cleared (SW-01)'
        );
        t.write('\x1b[1;1H\x1b[@'); // ICH, named by the fix commit as previously crashing
        assert.deepEqual(lines(t), [' a']);
        t.write('\x1b[1;1H\x1b[1K'); // EL 1, likewise
        assert.deepEqual(lines(t), [' a']);
      }),
  },

  // ---------------------------------------------------------------- lifecycle (shared instance)
  {
    name: 'lifecycle.grapheme-terminal-free-then-new',
    provenance: invariant(
      'freeing a terminal that held graphemes must not trap later terminals (RT-01, V-06)'
    ),
    run: (c) =>
      c.fresh((vt) => {
        const sequences = [
          ['abc', 'abc', 'abc'],
          ['e\u0301x', 'abc', 'abc'],
          ['abc', 'e\u0301x', 'abc', 'abc'],
          ['\u{1F44D}\u{1F3FD}', 'abc', 'abc'],
          ['\u{1F468}\u200d\u{1F469}', 'abc', 'abc'],
        ];
        for (const sequence of sequences) {
          for (const input of sequence) {
            const t = vt.createTerminal(20, 3);
            t.setMode(2027, true, { asDefault: true });
            t.write(input);
            if (input === 'abc') assert.deepEqual(lines(t), ['abc', '', ''], sequence.join(' → '));
            t.reset();
            t.dispose();
          }
        }
        assert.equal(vt.liveTerminalCount(), 0);
      }),
  },
  {
    name: 'lifecycle.no-stale-content-after-free',
    provenance: invariant(
      'a newly created terminal starts blank even when its memory is recycled from a freed one ' +
        '(include/ghostty/vt/terminal.h ghostty_terminal_new; core-lane finding: SECRET text leak)'
    ),
    run: (c) =>
      c.fresh((vt) => {
        const sizes: [number, number][] = [
          [40, 10],
          [40, 10],
          [20, 5],
          [80, 24],
          [40, 10],
        ];
        for (const [cycle, [cols, rows]] of sizes.entries()) {
          const secret = vt.createTerminal(cols, rows);
          for (let i = 0; i < rows * 3; i++) secret.write(`SECRET pass=hunter${cycle}-${i}\r\n`);
          secret.write('\u{1F44D}\u{1F3FD} e\u0301 \x1b[1;31mstyled');
          secret.dispose();
          const fresh = vt.createTerminal(cols, rows);
          const label = `cycle ${cycle} (${cols}x${rows})`;
          assert.equal(fresh.scrollbackRows(), 0, label);
          assert.equal(fresh.totalRows(), rows, label);
          assert.deepEqual(lines(fresh), Array(rows).fill(''), `${label}: blank before writing`);
          assert.equal(fresh.formatPlain({ unwrap: false, trim: true }), '', label);
          fresh.write('x');
          assert.deepEqual(
            lines(fresh),
            ['x', ...Array(rows - 1).fill('')],
            `${label}: after writing`
          );
          fresh.dispose();
        }
      }),
  },
  {
    name: 'loader.ownership-and-disposal',
    provenance: invariant(
      'test-only loader contract: disposed handles reject use; instance dispose frees all'
    ),
    run: (c) =>
      c.fresh((vt) => {
        const a = vt.createTerminal(5, 1);
        const b = vt.createTerminal(5, 1);
        a.write('a');
        b.write('b');
        assert.deepEqual([lines(a), lines(b)], [['a'], ['b']], 'terminals are independent');
        a.dispose();
        a.dispose(); // idempotent
        assert.throws(() => a.write('x'), /after dispose/);
        assert.deepEqual(lines(b), ['b'], 'bystander survives');
        assert.equal(vt.liveTerminalCount(), 1);
        vt.dispose();
        assert.equal(vt.liveTerminalCount(), 0);
        assert.throws(() => b.cursor(), /after dispose/);
        assert.throws(() => vt.createTerminal(1, 1), /after dispose/);
      }),
  },
];
