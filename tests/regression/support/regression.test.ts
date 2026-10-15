import { describe, expect, test } from 'bun:test';
import { RegressionAssertionError, regressionEngine, runRegression } from './regression';

describe('strict regression assertions', () => {
  test('successful assertions resolve normally, without an accepted-failure state', async () => {
    const result = await runRegression('ordinary.pass', (checks) => {
      checks.equal('nested.value', { a: [1, 'text'] }, { a: [1, 'text'] });
    });
    expect(result).toBeUndefined();
  });

  test('an assertion failure always rejects with its actual and expected values', async () => {
    let failure: unknown;
    try {
      await runRegression('ordinary.fail', (checks) => checks.equal('bytes', '62', '1b62'));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RegressionAssertionError);
    expect(failure).toMatchObject({ assertion: 'bytes', actual: '62', expected: '1b62' });
  });

  test('historically allowlisted ids get no special treatment', async () => {
    await expect(
      runRegression('key.alt-b', (checks) => checks.equal('output.bytes', ['62'], ['1b62']))
    ).rejects.toThrow('output.bytes');
  });

  test('the old signature cannot pass a manifest to suppress an error', async () => {
    const oldCall = runRegression as unknown as (...args: unknown[]) => Promise<void>;
    await expect(oldCall('key.alt-b', [{ id: 'key.alt-b' }], () => {})).rejects.toThrow(
      'assertion callback is required'
    );
  });

  for (const error of [
    new Error('setup failed'),
    new WebAssembly.RuntimeError('Out of bounds memory access'),
  ]) {
    test(`propagates ${error.name} unchanged`, async () => {
      await expect(
        runRegression('ordinary.exception', () => {
          throw error;
        })
      ).rejects.toBe(error);
    });
  }

  test('async failures propagate too', async () => {
    await expect(
      runRegression('async.failure', async () => {
        await Promise.resolve();
        throw new Error('late failure');
      })
    ).rejects.toThrow('late failure');
  });

  test('zero assertions cannot produce a pass', async () => {
    await expect(runRegression('empty.case', () => {})).rejects.toThrow('no assertions');
  });

  test('capability discovery alone is not a behavior assertion', async () => {
    await expect(
      runRegression('empty.case', (checks) => checks.requireCapabilities(['cells'], ['cells']))
    ).rejects.toThrow('no assertions');
  });

  test('missing capabilities fail instead of shrinking a comparison', async () => {
    await expect(
      runRegression('missing.capability', (checks) => {
        checks.requireCapabilities(new Set(['text']), ['cells', 'cursor']);
        checks.equal('empty.projection', {}, {});
      })
    ).rejects.toThrow('required capabilities missing: cells, cursor');
  });

  test('does not normalize away undefined cells or wide-character spacers', async () => {
    await expect(
      runRegression('normalizer.guard', (checks) => checks.equal('cells', [null], [undefined]))
    ).rejects.toThrow('cells');
    await expect(
      runRegression('normalizer.guard', (checks) => checks.equal('cells', ['中', ''], ['中', ' ']))
    ).rejects.toThrow('cells');
  });

  test('requires literal case and assertion ids', async () => {
    await expect(runRegression('wildcard.*', () => {})).rejects.toThrow('Invalid regression id');
    await expect(
      runRegression('valid.case', (checks) => checks.equal('bad *', 1, 1))
    ).rejects.toThrow('Invalid assertion id');
  });

  test('invalid engine labels are rejected', () => {
    const before = process.env.GHOSTTY_REGRESSION_ENGINE;
    try {
      process.env.GHOSTTY_REGRESSION_ENGINE = 'pretend-pass';
      expect(() => regressionEngine()).toThrow('Unknown regression engine');
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, 'GHOSTTY_REGRESSION_ENGINE');
      else process.env.GHOSTTY_REGRESSION_ENGINE = before;
    }
  });
});
