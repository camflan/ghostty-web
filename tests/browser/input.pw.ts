/**
 * Keyboard and focus through real Playwright page actions (CDP-dispatched,
 * trusted events). OS IME, dead keys on real layouts and accessibility tools
 * are out of reach here and stay manual release gates.
 *
 * Expected bytes follow Ghostty's encoders: legacy keys in
 * src/input/key_encode.zig and function_keys.zig; focus reports per
 * src/termio/Termio.zig (CSI I / CSI O on focus change while 1004 is set).
 */

import { rtest } from './support/fixture';

type Ctx = Parameters<Parameters<typeof rtest>[1]>[0];

/** Focus the terminal by clicking it, apply `setup`, run `act`, return emitted data. */
async function dataFrom(ctx: Ctx, setup: string, act: () => Promise<void>): Promise<string[]> {
  const term = await ctx.harness.create({ cols: 10, rows: 3 });
  if (setup) await term.writeAndSettle(setup);
  await term.clickCell(1, 1);
  await term.clearEvents();
  await act();
  await ctx.harness.frame();
  return (await term.events()).data;
}

rtest('input.printable-keys-emit-text', async (ctx) => {
  const data = await dataFrom(ctx, '', () => ctx.harness.page.keyboard.type('ab1'));
  ctx.checks.equal('typed-data', data, ['a', 'b', '1']);
});

rtest('input.control-and-navigation-keys', async (ctx) => {
  const keys = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'Control+c'];
  const data = await dataFrom(ctx, '', async () => {
    for (const key of keys) await ctx.harness.page.keyboard.press(key);
  });
  ctx.checks.equal('key-data', data, ['\r', '\x7f', '\t', '\x1b', '\x1b[A', '\x03']);
});

rtest('input.decckm-application-cursor-keys', async (ctx) => {
  const data = await dataFrom(ctx, '\x1b[?1h', () => ctx.harness.page.keyboard.press('ArrowUp'));
  ctx.checks.equal('decckm-arrow', data, ['\x1bOA']);
});

rtest('input.alt-letter-sends-esc-prefix', async (ctx) => {
  // key_encode.zig "legacy: alt+c": Alt with alt_esc_prefix (mode 1036, default on) → ESC c.
  const data = await dataFrom(ctx, '', () => ctx.harness.page.keyboard.press('Alt+b'));
  ctx.checks.equal('alt-b', data, ['\x1bb']);
});

rtest('input.kitty-disambiguate-escape', async (ctx) => {
  // Kitty keyboard protocol flag 1 (disambiguate) pushed by the application.
  const data = await dataFrom(ctx, '\x1b[>1u', () => ctx.harness.page.keyboard.press('Escape'));
  ctx.checks.equal('kitty-escape', data, ['\x1b[27u']);
});

rtest('input.kitty-exit-restores-control-keys', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 3 });
  await term.clickCell(1, 1);
  for (const flags of [1, 3]) {
    // Same protocol boundary as Vim -> shell -> tmux, using trusted key events.
    await term.writeAndSettle(`\x1b[?1049h\x1b[>${flags}u`);
    await ctx.harness.page.keyboard.press('a');
    await term.writeAndSettle('\x1b[<1u\x1b[?1049l');
    await term.clearEvents();
    await ctx.harness.page.keyboard.press('Control+b');
    await ctx.harness.page.keyboard.press('Control+c');
    await ctx.harness.frame();
    ctx.checks.equal(`controls-after-flags-${flags}`, (await term.events()).data, ['\x02', '\x03']);
  }
});

rtest('input.kitty-copy-shortcut-stays-in-browser', async (ctx) => {
  const data = await dataFrom(ctx, '\x1b[>3u', () => ctx.harness.page.keyboard.press('Meta+c'));
  // Copy is host-owned: neither its press nor its release belongs in PTY input.
  ctx.checks.equal('copy-shortcut-data', data, []);
});

rtest('input.layout-text-and-copy-remain-browser-safe', async (ctx) => {
  const term = await ctx.harness.create({ cols: 20, rows: 3 });
  await term.clickCell(1, 1);
  // CDP types non-ASCII via insertText, not physical keydown; target the existing
  // textarea beforeinput path explicitly (the canvas container rejects edits).
  await ctx.harness.page.locator('textarea').focus();
  await term.clearEvents();
  await ctx.harness.page.keyboard.type('aA!é😀');
  await ctx.harness.page.keyboard.press('Meta+c');
  await ctx.harness.frame();
  ctx.checks.equal('text-once-without-copy-bytes', (await term.events()).data.join(''), 'aA!é😀');
});

rtest('paste.clipboard-native-sanitization-and-mode-transitions', async (ctx) => {
  const term = await ctx.harness.create({ cols: 20, rows: 3 });
  await term.clickCell(1, 1);
  await ctx.harness.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const text = 'é\u0003\nend\u001b[201~';
  await ctx.harness.page.evaluate((value) => navigator.clipboard.writeText(value), text);
  for (const bracketed of [false, true, false]) {
    await term.writeAndSettle(bracketed ? '\x1b[?2004h' : '\x1b[?2004l');
    await term.clearEvents();
    await ctx.harness.page.keyboard.press('Control+v');
    await ctx.harness.page.waitForFunction(
      (id) => window.__ghosttyRegression.events(id).data.length > 0,
      term.id
    );
    await ctx.harness.frame();
    ctx.checks.equal(`clipboard-${bracketed ? 'bracketed' : 'plain'}`, (await term.events()).data, [
      bracketed ? '\x1b[200~é \nend [201~\x1b[201~' : 'é \rend [201~',
    ]);
  }
});

rtest('review.readonly-alternate-wheel-is-silent', async (ctx) => {
  const term = await ctx.harness.create({ cols: 20, rows: 5 });
  await term.writeAndSettle('\x1b[?1049h');
  const point = await term.cellCenter(2, 3);
  await ctx.harness.page.mouse.move(point.x, point.y);
  await term.setOptions({ disableStdin: true });
  await term.clearEvents();
  await ctx.harness.page.mouse.wheel(0, -99);
  await ctx.harness.frame();
  ctx.checks.equal('readonly-wheel', (await term.events()).data, []);
  await term.setOptions({ disableStdin: false });
  await ctx.harness.page.mouse.wheel(0, -99);
  await ctx.harness.page.waitForFunction(
    (id) => window.__ghosttyRegression.events(id).data.length > 0,
    term.id
  );
  ctx.checks.equal('enabled-wheel', (await term.events()).data, ['\x1b[A', '\x1b[A', '\x1b[A']);
});

rtest('review.kitty-release-survives-internal-focus', async (ctx) => {
  const term = await ctx.harness.create({ cols: 20, rows: 5 });
  await term.writeAndSettle('\x1b[>3u');
  for (const fromTextarea of [false, true]) {
    const first = fromTextarea ? 'textarea' : '.host';
    const second = fromTextarea ? '.host' : 'textarea';
    await ctx.harness.page.locator(first).evaluate((node) => (node as HTMLElement).focus());
    await term.clearEvents();
    await ctx.harness.page.keyboard.down('a');
    await ctx.harness.page.locator(second).evaluate((node) => (node as HTMLElement).focus());
    await ctx.harness.page.keyboard.up('a');
    ctx.checks.equal(
      `paired-release-${fromTextarea ? 'textarea' : 'container'}`,
      (await term.events()).data,
      ['a', '\x1b[97;1:3u']
    );
  }
});

rtest('review.kitty-modifier-reports-preserve-selection', async (ctx) => {
  const term = await ctx.harness.create({ cols: 20, rows: 5 });
  await term.writeAndSettle('hello\x1b[>11u');
  await term.clickCell(2, 2);
  await term.select(0, 0, 5);
  await term.clearEvents();
  await ctx.harness.page.keyboard.down('Shift');
  await ctx.harness.page.keyboard.up('Shift');
  ctx.checks.equal('modifier-bytes', (await term.events()).data, [
    '\x1b[57441;2u',
    '\x1b[57441;1:3u',
  ]);
  ctx.checks.equal('selection-preserved', await term.selection(), 'hello');
});

rtest('focus.reports-blur-and-focus-when-1004-set', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 3 });
  await term.writeAndSettle('\x1b[?1004h');
  await term.clickCell(1, 1);
  await term.clearEvents();
  await ctx.harness.page.click('#outside');
  await term.clickCell(1, 1);
  await ctx.harness.frame();
  ctx.checks.equal('focus-reports', (await term.events()).data, ['\x1b[O', '\x1b[I']);
});

rtest('focus.internal-transfers-and-disabled-stdin', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 3 });
  await term.writeAndSettle('\x1b[?1004h');
  await term.clearEvents();
  // Playwright's locator.focus() first blurs the active element explicitly,
  // producing a real loss with relatedTarget=null. Use DOM focus directly to
  // exercise the internal transfer performed by Terminal/SelectionManager.
  await ctx.harness.page.locator('textarea').evaluate((node) => node.focus());
  await ctx.harness.page.locator('.host').evaluate((node) => (node as HTMLElement).focus());
  await term.clickCell(1, 1);
  await ctx.harness.frame();
  ctx.checks.equal('internal-transfers', (await term.events()).data, []);
  await term.setOptions({ disableStdin: true });
  await ctx.harness.page.click('#outside');
  await term.clickCell(1, 1);
  await ctx.harness.page.click('#outside');
  await term.setOptions({ disableStdin: false });
  ctx.checks.equal('disabled-and-no-catch-up', (await term.events()).data, []);
  await term.clickCell(1, 1);
  await ctx.harness.page.click('#outside');
  await ctx.harness.frame();
  ctx.checks.equal('reenabled-focus-changes', (await term.events()).data, ['\x1b[I', '\x1b[O']);
});

rtest('focus.no-reports-without-1004', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 3 });
  await term.clickCell(1, 1);
  await term.clearEvents();
  await ctx.harness.page.click('#outside');
  await term.clickCell(1, 1);
  await ctx.harness.frame();
  ctx.checks.equal('focus-reports', (await term.events()).data, []);
});
