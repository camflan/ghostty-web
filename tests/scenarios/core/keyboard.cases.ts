import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Key, KeyAction, KeyEncoderOption, Mods } from '../../../lib/index';
/**
 * L2: byte-exact keyboard output (WEB-07, IN-01…IN-03).
 *
 * DOM cases dispatch synthetic happy-dom `keydown`/`keyup` events on the
 * terminal container. They exercise ghostty-web's InputHandler logic with a
 * Linux/Windows-style keymap only: no IME, layout mapping, OS shortcuts or
 * browser default actions are modelled (those are manual/browser gates).
 * Expected bytes come from Ghostty's key encoder tests and xterm conventions;
 * encoder cases show which defects are in the JS layer rather than the core.
 */
import {
  describe,
  expect,
  legacyAbiCase,
  regressionCase,
  test,
} from '../../regression/core/harness/scenario';
import {
  type WebSession,
  freshGhostty,
  guarded,
  hex,
  hexChunks,
  keydown,
  keyup,
  openTerminal,
} from '../../regression/core/harness/web';

const E = '\x1b';

function typed(
  init: KeyboardEventInit,
  setup = '',
  options: { cols?: number; rows?: number } = {}
): string[] {
  const session = openTerminal(options);
  return guarded(
    () => {
      if (setup) session.term.write(setup);
      session.data.length = 0;
      keydown(session.container, init);
      return hexChunks(session.data);
    },
    () => session.dispose()
  );
}

function withSession<T>(body: (s: WebSession) => T): T {
  const session = openTerminal();
  return guarded(
    () => {
      return body(session);
    },
    () => session.dispose()
  );
}

describe('keyboard: legacy encoding through the DOM input path', () => {
  const passing: Array<[string, KeyboardEventInit, string, string[]]> = [
    ['key.plain-a', { key: 'a', code: 'KeyA' }, '', ['61']],
    ['key.shift-a', { key: 'A', code: 'KeyA', shiftKey: true }, '', ['41']],
    ['key.enter', { key: 'Enter', code: 'Enter' }, '', ['0d']],
    ['key.backspace', { key: 'Backspace', code: 'Backspace' }, '', ['7f']],
    ['key.tab', { key: 'Tab', code: 'Tab' }, '', ['09']],
    ['key.shift-tab', { key: 'Tab', code: 'Tab', shiftKey: true }, '', [hex(`${E}[Z`)]],
    ['key.escape', { key: 'Escape', code: 'Escape' }, '', ['1b']],
    ['key.ctrl-c', { key: 'c', code: 'KeyC', ctrlKey: true }, '', ['03']],
    ['key.ctrl-a', { key: 'a', code: 'KeyA', ctrlKey: true }, '', ['01']],
    ['key.arrow-up', { key: 'ArrowUp', code: 'ArrowUp' }, '', [hex(`${E}[A`)]],
    ['key.arrow-up-decckm', { key: 'ArrowUp', code: 'ArrowUp' }, `${E}[?1h`, [hex(`${E}OA`)]],
    [
      'key.ctrl-arrow-left',
      { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true },
      '',
      [hex(`${E}[1;5D`)],
    ],
    [
      'key.shift-arrow-up',
      { key: 'ArrowUp', code: 'ArrowUp', shiftKey: true },
      '',
      [hex(`${E}[1;2A`)],
    ],
    ['key.home', { key: 'Home', code: 'Home' }, '', [hex(`${E}[H`)]],
    ['key.delete', { key: 'Delete', code: 'Delete' }, '', [hex(`${E}[3~`)]],
    ['key.page-up', { key: 'PageUp', code: 'PageUp' }, '', [hex(`${E}[5~`)]],
    ['key.f1', { key: 'F1', code: 'F1' }, '', [hex(`${E}OP`)]],
    ['key.f5', { key: 'F5', code: 'F5' }, '', [hex(`${E}[15~`)]],
  ];
  for (const [id, init, setup, expected] of passing) {
    regressionCase(id, (checks) => checks.equal('output.bytes', typed(init, setup), expected));
  }

  // Known defects: expectations are Ghostty's native bytes.
  regressionCase('key.alt-b', (checks) => {
    // Mode 1036 (Alt sends ESC) defaults on; upstream test "legacy: alt+c".
    checks.equal('output.bytes', typed({ key: 'b', code: 'KeyB', altKey: true }), ['1b62']);
  });
  regressionCase('key.alt-period', (checks) => {
    checks.equal('output.bytes', typed({ key: '.', code: 'Period', altKey: true }), ['1b2e']);
  });
  regressionCase('key.ctrl-alt-c', (checks) => {
    // upstream key_encode.zig test "legacy: ctrl+alt+c" => "\x1b\x03"
    checks.equal('output.bytes', typed({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }), [
      '1b03',
    ]);
  });
  regressionCase('key.shift-f5', (checks) => {
    checks.equal('output.bytes', typed({ key: 'F5', code: 'F5', shiftKey: true }), [
      hex(`${E}[15;2~`),
    ]);
  });
  regressionCase('key.shift-home', (checks) => {
    checks.equal('output.bytes', typed({ key: 'Home', code: 'Home', shiftKey: true }), [
      hex(`${E}[1;2H`),
    ]);
  });
  regressionCase('key.home-decckm', (checks) => {
    checks.equal('output.bytes', typed({ key: 'Home', code: 'Home' }, `${E}[?1h`), [hex(`${E}OH`)]);
  });
});

describe('keyboard: Kitty protocol pushed by the application', () => {
  regressionCase('key.kitty-flags-readable-mode-free', (checks) => {
    // Control: pushing flags must not print or reply.
    withSession((s) => {
      s.term.write(`${E}[>1u`);
      checks.equal('replies', hexChunks(s.data), []);
    });
  });
  regressionCase('key.kitty1-escape', (checks) => {
    checks.equal('output.bytes', typed({ key: 'Escape', code: 'Escape' }, `${E}[>1u`), [
      hex(`${E}[27u`),
    ]);
  });
  regressionCase('key.kitty1-ctrl-c', (checks) => {
    checks.equal('output.bytes', typed({ key: 'c', code: 'KeyC', ctrlKey: true }, `${E}[>1u`), [
      hex(`${E}[99;5u`),
    ]);
  });
  regressionCase('key.kitty1-shift-enter', (checks) => {
    checks.equal(
      'output.bytes',
      typed({ key: 'Enter', code: 'Enter', shiftKey: true }, `${E}[>1u`),
      [hex(`${E}[13;2u`)]
    );
  });
  regressionCase('key.kitty1-plain-text-stays-text', (checks) => {
    checks.equal('output.bytes', typed({ key: 'a', code: 'KeyA' }, `${E}[>1u`), ['61']);
  });
  regressionCase('key.kitty3-release', (checks) => {
    withSession((s) => {
      s.term.write(`${E}[>3u`);
      keydown(s.container, { key: 'a', code: 'KeyA' });
      keyup(s.container, { key: 'a', code: 'KeyA' });
      checks.equal('output.bytes', hexChunks(s.data), ['61', hex(`${E}[97;1:3u`)]);
    });
  });
});

describe('keyboard: Kitty releases respect browser and host ownership', () => {
  regressionCase('key.kitty-host-shortcuts-suppress-release', (checks) => {
    withSession((s) => {
      s.term.write(`${E}[>3u`);
      s.term.attachCustomKeyEventHandler((event) => event.code === 'KeyA');
      const shortcuts: Array<[string, KeyboardEventInit]> = [
        ['custom', { key: 'a', code: 'KeyA' }],
        ['ctrl-paste', { key: 'v', code: 'KeyV', ctrlKey: true }],
        ['cmd-paste', { key: 'v', code: 'KeyV', metaKey: true }],
        ['cmd-copy', { key: 'c', code: 'KeyC', metaKey: true }],
      ];
      for (const [name, event] of shortcuts) {
        s.data.length = 0;
        keydown(s.container, event);
        keyup(s.container, event);
        checks.equal(`${name}.bytes`, hexChunks(s.data), []);
      }
    });
  });

  regressionCase('key.kitty-release-needs-forwarded-press', (checks) => {
    withSession((s) => {
      s.term.write(`${E}[>3u`);
      keyup(s.container, { key: 'a', code: 'KeyA' });
      checks.equal('unpaired-release.bytes', hexChunks(s.data), []);
      keydown(s.container, { key: 'a', code: 'KeyA' });
      s.container.dispatchEvent(new FocusEvent('blur'));
      s.data.length = 0;
      keyup(s.container, { key: 'a', code: 'KeyA' });
      checks.equal('release-after-blur.bytes', hexChunks(s.data), []);
    });
  });
});

describe('keyboard: leaving an application restores control keys', () => {
  // Real Vim pushes Kitty flags, causes the encoder to synchronize, then pops
  // them on exit. The next shell/tmux key must not inherit that cached protocol.
  const exits: Array<[string, string, (s: WebSession) => void]> = [
    ['key.kitty-pop-restores-controls', '', (s) => s.term.write(`${E}[<1u`)],
    ['key.kitty-disable-restores-controls', '', (s) => s.term.write(`${E}[=0u`)],
    ['key.kitty-ris-restores-controls', '', (s) => s.term.write(`${E}c`)],
    ['key.kitty-reset-restores-controls', '', (s) => s.term.reset()],
    ['key.kitty-alt-exit-restores-controls', `${E}[?1049h`, (s) => s.term.write(`${E}[?1049l`)],
  ];
  for (const [id, enter, leave] of exits) {
    regressionCase(id, (checks) => {
      withSession((s) => {
        // Exercise more than one entry/exit cycle, including release reporting.
        for (const flags of [1, 3]) {
          s.term.write(`${enter}${E}[>${flags}u`);
          keydown(s.container, { key: 'a', code: 'KeyA' });
          keyup(s.container, { key: 'a', code: 'KeyA' });
          leave(s);
          s.data.length = 0;
          for (const key of ['b', 'c', 'u']) {
            const event = { key, code: `Key${key.toUpperCase()}`, ctrlKey: true };
            keydown(s.container, event);
            keyup(s.container, event);
          }
          checks.equal(`controls-after-flags-${flags}`, hexChunks(s.data), ['02', '03', '15']);
        }
      });
    });
  }
});

describe('keyboard: pinned key encoder (core) with JS-supplied options', () => {
  function encode(
    opts: Array<[KeyEncoderOption, boolean | number]>,
    event: Parameters<ReturnType<ReturnType<typeof freshGhostty>['createKeyEncoder']>['encode']>[0]
  ): string {
    const encoder = freshGhostty().createKeyEncoder();
    return guarded(
      () => {
        for (const [option, value] of opts) encoder.setOption(option, value);
        return hex(encoder.encode(event));
      },
      () => encoder.dispose()
    );
  }
  const P = KeyAction.PRESS;
  const cases: Array<
    [string, Array<[KeyEncoderOption, boolean | number]>, Parameters<typeof encode>[1], string]
  > = [
    [
      'encoder.alt-esc-prefix',
      [[KeyEncoderOption.ALT_ESC_PREFIX, true]],
      { action: P, key: Key.B, mods: Mods.ALT, utf8: 'b' },
      '1b62',
    ],
    ['encoder.shift-f5', [], { action: P, key: Key.F5, mods: Mods.SHIFT }, hex(`${E}[15;2~`)],
    ['encoder.shift-home', [], { action: P, key: Key.HOME, mods: Mods.SHIFT }, hex(`${E}[1;2H`)],
    [
      'encoder.decckm-home',
      [[KeyEncoderOption.CURSOR_KEY_APPLICATION, true]],
      { action: P, key: Key.HOME, mods: Mods.NONE },
      hex(`${E}OH`),
    ],
    [
      'encoder.kitty1-escape',
      [[KeyEncoderOption.KITTY_KEYBOARD_FLAGS, 1]],
      { action: P, key: Key.ESCAPE, mods: Mods.NONE },
      hex(`${E}[27u`),
    ],
    [
      'encoder.kitty1-shift-enter',
      [[KeyEncoderOption.KITTY_KEYBOARD_FLAGS, 1]],
      { action: P, key: Key.ENTER, mods: Mods.SHIFT },
      hex(`${E}[13;2u`),
    ],
  ];
  for (const [id, opts, event, expected] of cases) {
    regressionCase(id, (checks) => checks.equal('encoded', encode(opts, event), expected));
  }

  regressionCase('encoder.unshifted-codepoint-honoured', (checks) => {
    // IN-03: KeyEvent declares unshiftedCodepoint but KeyEncoder.encode never passes it,
    // so Kitty Ctrl+C encodes to nothing. Raw exports with the codepoint give ESC[99;5u.
    checks.equal(
      'encoded',
      encode([[KeyEncoderOption.KITTY_KEYBOARD_FLAGS, 1]], {
        action: P,
        key: Key.C,
        mods: Mods.CTRL,
        utf8: 'c',
        unshiftedCodepoint: 0x63,
      }),
      hex(`${E}[99;5u`)
    );
  });
});

describe('keyboard: public Key semantics through the key encoder (any backend)', () => {
  // Kitty "report all keys as escape codes" (flags 8 | disambiguate 1) gives every
  // functional key a distinct, spec-defined code, so each public Key name must reach
  // the encoder as the key it names. Codes: Kitty keyboard protocol functional-key
  // table (Scroll Lock 57359, Num Lock 57360, Print Screen 57361, Pause 57362, F13 57376).
  function kittyReportAll(key: Key): string {
    const encoder = freshGhostty().createKeyEncoder();
    return guarded(
      () => {
        encoder.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, 9);
        return hex(encoder.encode({ action: KeyAction.PRESS, key, mods: Mods.NONE }));
      },
      () => encoder.dispose()
    );
  }
  regressionCase('key-encoding.num-lock', (checks) => {
    checks.equal('encoded', kittyReportAll(Key.NUM_LOCK), hex(`${E}[57360u`));
  });
  regressionCase('key-encoding.f13', (checks) => {
    checks.equal('encoded', kittyReportAll(Key.F13), hex(`${E}[57376u`));
  });
  regressionCase('key-encoding.print-screen', (checks) => {
    checks.equal('encoded', kittyReportAll(Key.PRINT_SCREEN), hex(`${E}[57361u`));
  });
  regressionCase('key-encoding.scroll-lock', (checks) => {
    checks.equal('encoded', kittyReportAll(Key.SCROLL_LOCK), hex(`${E}[57359u`));
  });
  regressionCase('key-encoding.pause', (checks) => {
    checks.equal('encoded', kittyReportAll(Key.PAUSE), hex(`${E}[57362u`));
  });
});

describe('keyboard: public Key numbers vs the LEGACY C ABI (frozen pinned header)', () => {
  // The legacy bridge passes public Key numbers to the WASM unchanged, so they must
  // equal the legacy ABI's GhosttyKey values. The oracle is a frozen copy of the
  // pinned 5714ed07 header (fixtures/legacy-key-event.h), not the submodule, whose
  // header describes whatever libghostty-vt is checked out. A libghostty-vt bridge
  // maps public Key names through the binary's manifest instead; its behaviour is
  // covered by the key-encoding.* cases above.
  const LEGACY_HEADER_SHA256 = '35e7430bf990d4ca460ef1c472a65d17cf4b5a000c88d9d53b00a6f95e45ae03';
  const MARKER = '/* END-OF-PROVENANCE */\n';
  const fixture = readFileSync(new URL('./fixtures/legacy-key-event.h', import.meta.url), 'utf8');
  const header = fixture.slice(fixture.indexOf(MARKER) + MARKER.length);
  const body = header.slice(
    header.indexOf('typedef enum {', header.indexOf('GHOSTTY_KEY_UNIDENTIFIED') - 200)
  );
  const names = [
    ...body
      .slice(0, body.indexOf('} GhosttyKey;'))
      .matchAll(/^\s*GHOSTTY_KEY_([A-Z0-9_]+)(?:\s*=\s*(\d+))?,/gm),
  ];
  const values = new Map<string, number>();
  let next = 0;
  for (const [, name, explicit] of names) {
    const value = explicit === undefined ? next : Number(explicit);
    values.set(name, value);
    next = value + 1;
  }
  const tsKeys = Key as unknown as Record<string, number>;

  test('frozen legacy header is byte-identical to the pinned upstream file', () => {
    expect(fixture.includes(MARKER)).toBe(true);
    expect(createHash('sha256').update(header).digest('hex')).toBe(LEGACY_HEADER_SHA256);
  });

  test('legacy header parsing found the key enum', () => {
    expect(values.get('UNIDENTIFIED')).toBe(0);
    expect(values.get('FN')).toBe(146);
    expect(values.size).toBeGreaterThan(150);
  });

  legacyAbiCase('legacy-key-abi.before-fn', (checks) => {
    const mismatches = [...values]
      .filter(
        ([name, value]) =>
          value < (values.get('FN') ?? 0) && name in tsKeys && tsKeys[name] !== value
      )
      .map(([name]) => name);
    checks.equal('mismatches', mismatches, []);
  });

  legacyAbiCase('legacy-key-abi.fn-lock-onward', (checks) => {
    // WEB-07 enum drift: lib/types.ts omits GHOSTTY_KEY_FN, so later keys are off by one.
    const sample = ['FN_LOCK', 'PRINT_SCREEN', 'PASTE'];
    checks.equal(
      'values',
      sample.map((name) => tsKeys[name]),
      sample.map((name) => values.get(name))
    );
  });
});
