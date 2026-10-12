/**
 * Harness readiness and its negative controls. Every vendored font must be
 * digest-verified and actually loaded; if one is missing or altered,
 * readiness fails loudly instead of rendering with a fallback font (the
 * defect in PR #128's runner, which continued anyway).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { HARNESS_PATH, controlTest, rtest } from './support/fixture';

interface FontEntry {
  role: string;
  family: string;
  file: string;
  sha256: string;
}

const FONTS = (
  JSON.parse(readFileSync(new URL('./fonts/font.json', import.meta.url), 'utf8')) as {
    fonts: FontEntry[];
  }
).fonts;
const byRole = (role: string): FontEntry => {
  const font = FONTS.find((f) => f.role === role);
  if (!font) throw new Error(`fonts/font.json has no '${role}' font`);
  return font;
};

rtest('font.vendored-fonts-verified', async ({ harness, checks }) => {
  checks.equal('roles', Object.keys(harness.info.fonts).sort(), ['alternate', 'primary']);
  checks.equal('primary-is-default', harness.info.font.family, byRole('primary').family);
  for (const role of ['primary', 'alternate']) {
    const font = harness.info.fonts[role];
    checks.equal(`${role}-sha256`, font.sha256, byRole(role).sha256);
    checks.equal(`${role}-family`, font.family, byRole(role).family);
    const tableAdvance = (font.advanceUnits * font.sizePx) / font.unitsPerEm;
    checks.equal(
      `${role}-advance-matches-table`,
      font.measuredAdvance === Math.round(tableAdvance) ||
        Math.abs(font.measuredAdvance - tableAdvance) <= 0.01,
      true
    );
  }
});

rtest('font.wasm-identity-reported', async ({ harness, checks }) => {
  const { wasm } = harness.info;
  checks.equal('wasm-sha256-format', /^[0-9a-f]{64}$/.test(wasm.sha256), true);
  checks.equal('wasm-nonempty', wasm.bytes > 100_000, true);
});

// Negative controls run on a bare page: readiness itself is what is under test.

async function readinessOutcome(page: import('@playwright/test').Page): Promise<string> {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__ghosttyRegression !== undefined);
  return page.evaluate(() =>
    window.__ghosttyRegression.ready.then(
      () => 'ready',
      (error: Error) => error.message
    )
  );
}

controlTest('font.missing-primary-font-fails-readiness', async ({ page }) => {
  await page.route(`**/tests/browser/fonts/${byRole('primary').file}`, (route) =>
    route.fulfill({ status: 404, body: 'gone' })
  );
  expect(await readinessOutcome(page)).toMatch(/^FONT_NOT_LOADED: .*HTTP 404$/);
});

controlTest('font.altered-alternate-font-fails-readiness', async ({ page }) => {
  const file = byRole('alternate').file;
  const bytes = readFileSync(new URL(`./fonts/${file}`, import.meta.url));
  await page.route(`**/tests/browser/fonts/${file}`, (route) =>
    route.fulfill({ status: 200, contentType: 'font/ttf', body: bytes.subarray(0, 4096) })
  );
  expect(await readinessOutcome(page)).toBe(
    `FONT_NOT_LOADED: ${file} is 4096 B sha256 ${sha256Hex(bytes.subarray(0, 4096))}`
  );
});

controlTest('font.swapped-fonts-fail-readiness', async ({ page }) => {
  // Serving the primary bytes in place of the alternate must not pass as "loaded".
  const primary = readFileSync(new URL(`./fonts/${byRole('primary').file}`, import.meta.url));
  await page.route(`**/tests/browser/fonts/${byRole('alternate').file}`, (route) =>
    route.fulfill({ status: 200, contentType: 'font/ttf', body: primary })
  );
  expect(await readinessOutcome(page)).toMatch(
    new RegExp(`^FONT_NOT_LOADED: ${byRole('alternate').file.replace('.', '\\.')} is `)
  );
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
