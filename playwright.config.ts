// Required browser suite (CI). Always required, whatever the ambient environment;
// gap reproducers run only through playwright.gaps.config.ts.
import { browserConfig } from './tests/browser/support/playwright-config';

export default browserConfig('required');
