/**
 * Synchronized output (DEC mode 2026): while set, the renderer must keep the
 * last complete frame on screen; on reset it must paint the new state.
 */

import { THEME, expectProbe, expectSameCells, rtest } from './support/fixture';
import { cellInterior, uniformColor } from './support/pixels';

const FRAME = '\x1b[1;1H\x1b[41m    \x1b[0m\x1b[2;8H';

rtest('sync.mode-2026-state-tracked', async ({ harness, checks }) => {
  const term = await harness.create({ cols: 8, rows: 2 });
  await term.writeAndSettle('\x1b[?2026h');
  checks.equal('set', await term.mode(2026), true);
  await term.writeAndSettle('\x1b[?2026l');
  checks.equal('reset', await term.mode(2026), false);
});

rtest('sync.hold-keeps-last-complete-frame', async (ctx) => {
  const term = await ctx.harness.create({ cols: 8, rows: 2 });
  await term.writeAndSettle('ab\x1b[2;8H');
  const before = await term.capture();
  await term.writeAndSettle(`\x1b[?2026h${FRAME}`);
  const during = await term.capture();
  await expectSameCells(
    ctx,
    'canvas-unchanged-while-held',
    during.image,
    before.image,
    during.grid
  );
});

rtest('sync.release-paints-new-frame', async (ctx) => {
  const term = await ctx.harness.create({ cols: 8, rows: 2 });
  await term.writeAndSettle(`\x1b[?2026h${FRAME}\x1b[?2026l`);
  const { image, grid } = await term.capture();
  await expectProbe(
    ctx,
    'frame-painted-after-release',
    uniformColor(image, cellInterior(grid, 0, 0)),
    THEME.red,
    image
  );
});
