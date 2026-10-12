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

rtest('focus.no-reports-without-1004', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 3 });
  await term.clickCell(1, 1);
  await term.clearEvents();
  await ctx.harness.page.click('#outside');
  await term.clickCell(1, 1);
  await ctx.harness.frame();
  ctx.checks.equal('focus-reports', (await term.events()).data, []);
});
