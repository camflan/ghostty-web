/**
 * Required core lane entry, found by default `bun test` discovery.
 * Definitions: tests/scenarios/core/lifecycle.cases.ts. Scope: ./scope.json.
 * The lane is this literal; no environment variable can turn it into the gap lane.
 * Bun's own describe/test from THIS file are passed in (shared-module registration misfiles tests).
 */
import { describe, test } from 'bun:test';
import { registerScenarios } from './harness/scenario';

await registerScenarios(['lifecycle'], 'required', { describe, test });
