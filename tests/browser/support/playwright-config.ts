/**
 * Shared Playwright configuration for the two browser suites.
 *
 *   playwright.config.ts       -> browserConfig('required')   (CI; always required)
 *   playwright.gaps.config.ts  -> browserConfig('gaps')       (explicit, local/backlog only)
 *
 * The suite is fixed by the config file, never by ambient environment: this sets
 * GHOSTTY_BROWSER_SUITE for the config process and its workers (overwriting any
 * inherited value) and records it in `metadata`, which every registered test
 * checks at run time. Both configs fail closed before running anything if the
 * static catalogue and scope.json disagree or the gap entries do not mirror the
 * specs. The gap config refuses to load when GHOSTTY_REQUIRED_CI=1, so it can
 * never replace the required contract in required CI.
 */
import { type PlaywrightTestConfig, defineConfig } from '@playwright/test';
import { assertCatalogueMatches } from '../../regression/support/scope';
import type { SuiteKind } from '../../regression/support/scope';
import { assertGapEntriesMirrorSpecs, declaredCases } from './case-catalogue';
import { SUITE_ENV, SUITE_METADATA_KEY, loadScopePlan, webEngine } from './suite';

export function browserConfig(suite: SuiteKind): PlaywrightTestConfig {
  if (suite === 'gaps' && process.env.GHOSTTY_REQUIRED_CI === '1') {
    throw new Error(
      'playwright.gaps.config.ts refuses to run with GHOSTTY_REQUIRED_CI=1: required CI runs ' +
        'playwright.config.ts only; gap reproducers are an explicit local/backlog run'
    );
  }
  const ambient = process.env[SUITE_ENV];
  if (ambient !== undefined && ambient !== suite && !process.env.TEST_WORKER_INDEX) {
    console.warn(
      `[browser] ignoring ambient ${SUITE_ENV}=${ambient}: this config runs the ${suite} suite`
    );
  }
  process.env[SUITE_ENV] = suite;
  // Fail closed on configuration problems before any test runs.
  webEngine();
  assertCatalogueMatches(
    loadScopePlan(),
    declaredCases().map((entry) => entry.id)
  );
  assertGapEntriesMirrorSpecs();

  const port = Number(process.env.GHOSTTY_REGRESSION_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('GHOSTTY_REGRESSION_PORT must be an integer between 1024 and 65535');
  }
  const baseURL = `http://127.0.0.1:${port}`;
  const suffix = `${suite === 'gaps' ? '-gaps' : ''}${port === 4173 ? '' : `-${port}`}`;

  return defineConfig({
    // Paths resolve relative to the root config file that calls this factory.
    // Required specs live in tests/browser (*.pw.ts); gap entries in tests/gaps/browser
    // (*.gap.ts) import the same specs. Bun only collects *.test.ts/*.spec.ts.
    testDir: suite === 'gaps' ? './tests/gaps/browser' : './tests/browser',
    testMatch: suite === 'gaps' ? '**/*.gap.ts' : '**/*.pw.ts',
    metadata: { [SUITE_METADATA_KEY]: suite },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: !!process.env.CI,
    timeout: 30_000,
    expect: { timeout: 5_000 },
    outputDir: `test-results/browser${suffix}`,
    reporter: [['list'], ['html', { outputFolder: `playwright-report${suffix}`, open: 'never' }]],
    use: {
      baseURL,
      browserName: 'chromium',
      viewport: { width: 1000, height: 700 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'off',
      launchOptions: {
        // Opt-in for local diagnosis only; CI uses Playwright's pinned browser.
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      },
    },
    webServer: {
      command: `bunx --no-install vite --host 127.0.0.1 --port ${port} --strictPort`,
      url: `${baseURL}/tests/browser/harness.html`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  });
}
