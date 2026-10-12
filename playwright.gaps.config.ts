// Gap (backlog) browser suite: explicit opt-in only, e.g.
//   bunx playwright test -c playwright.gaps.config.ts
// Runs the desired assertions of every case scope.json lists as a gap for the
// engine; failures fail the run (non-zero exit). Refuses GHOSTTY_REQUIRED_CI=1.
import { browserConfig } from './tests/browser/support/playwright-config';

export default browserConfig('gaps');
