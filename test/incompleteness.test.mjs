import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { INCOMPLETE_RULES, analyzeWorkflow, validateWorkflowFile } from '../src/index.mjs'

/**
 * Every rule that marks a run incomplete, and a case that goes red when it
 * stops doing so.
 *
 * `incomplete` is the only thing that keeps a declaration this tool could not
 * read from producing a verdict. Deleting one such flag in another tool let an
 * entirely unread input report `pass` with the whole suite still green, so
 * each rule below is driven through the real entry point and the status is
 * asserted literally. Remove an id from `INCOMPLETE_RULES` and exactly one of
 * these turns red:
 *
 * - for an error-severity rule the status becomes `fail`, which is a verdict
 *   about a workflow nobody managed to read;
 * - for `no-steps-declared` and `producer-version-unknown`, both warnings, the
 *   status becomes `pass`, which is green on no evidence.
 *
 * The second case is why the severity of those two is not the guard. Their
 * `errors` count is zero and is asserted as zero here, so nothing but the
 * incompleteness of the run stands between them and exit 0.
 */

const spec = (extra) => ({ schemaVersion: '1', ...extra })
const step = (id, extra = {}) => ({ id, version: '1.0.0', ...extra })
const encode = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))

const CASES = [
  { ruleId: 'dependency-malformed', input: spec({ steps: [step('one', { requires: [{ id: 'two' }] })] }) },
  {
    ruleId: 'graph-budget-exceeded',
    limits: { maxGraphOperations: 1 },
    input: spec({ steps: [step('one'), step('two', { requires: ['one'] }), step('three', { requires: ['two'] })] }),
  },
  {
    ruleId: 'graph-too-deep',
    limits: { maxDepth: 2 },
    input: spec({ steps: [step('one'), step('two', { requires: ['one'] }), step('three', { requires: ['two'] })] }),
  },
  { ruleId: 'no-steps-declared', errors: 0, input: spec({ provided: [{ name: 'seed', type: 'string' }], steps: [] }) },
  {
    ruleId: 'port-duplicated',
    input: spec({ steps: [step('one', { outputs: [{ name: 'out', type: 'A' }, { name: 'out', type: 'A' }] })] }),
  },
  { ruleId: 'port-malformed', input: spec({ steps: [step('one', { outputs: ['out'] })] }) },
  { ruleId: 'port-name-invalid', input: spec({ steps: [step('one', { outputs: [{ name: '-out', type: 'A' }] })] }) },
  { ruleId: 'port-type-invalid', input: spec({ steps: [step('one', { outputs: [{ name: 'out', type: '[]' }] })] }) },
  {
    ruleId: 'producer-version-unknown',
    errors: 0,
    input: spec({
      provided: [{ name: 'seed', type: 'A' }],
      steps: [step('one', { inputs: [{ name: 'seed', type: 'A', minVersion: '3.0.0' }] })],
    }),
  },
  { ruleId: 'spec-malformed', input: spec({ steps: [step('one')], workflow: ['not', 'a', 'string'] }) },
  { ruleId: 'spec-not-json', input: '[unclosed' },
  { ruleId: 'spec-not-utf8', bytes: [0xc3, 0x28] },
  { ruleId: 'spec-too-large', limits: { maxBytes: 2 }, input: spec({ steps: [step('one')] }) },
  { ruleId: 'spec-unreadable', missing: true },
  { ruleId: 'step-id-duplicated', input: spec({ steps: [step('twin'), step('twin', { requires: [] })] }) },
  { ruleId: 'step-id-invalid', input: spec({ steps: [{ id: 'has space', version: '1.0.0' }] }) },
  { ruleId: 'step-malformed', input: spec({ steps: [{ id: 'one', version: '1.0.0', inputs: 'none' }] }) },
  { ruleId: 'step-version-invalid', input: spec({ steps: [{ id: 'one' }] }) },
  { ruleId: 'time-budget-exceeded', limits: { maxMillis: 0 }, input: spec({ steps: [step('one')] }) },
  {
    ruleId: 'too-many-dependencies',
    limits: { maxDependenciesPerStep: 2 },
    input: spec({ steps: [step('one', { requires: ['two', 'three', 'four'] }), step('two'), step('three'), step('four')] }),
  },
  {
    ruleId: 'too-many-exports',
    limits: { maxExports: 2 },
    input: spec({
      exports: [{ name: 'a', type: 'A' }, { name: 'b', type: 'A' }, { name: 'c', type: 'A' }],
      steps: [step('one')],
    }),
  },
  {
    ruleId: 'too-many-ports',
    limits: { maxPortsPerStep: 2 },
    input: spec({
      steps: [step('one', { outputs: [{ name: 'a', type: 'A' }, { name: 'b', type: 'A' }, { name: 'c', type: 'A' }] })],
    }),
  },
  {
    ruleId: 'too-many-provided',
    limits: { maxProvided: 2 },
    input: spec({
      provided: [{ name: 'a', type: 'A' }, { name: 'b', type: 'A' }, { name: 'c', type: 'A' }],
      steps: [step('one')],
    }),
  },
  { ruleId: 'too-many-steps', limits: { maxSteps: 2 }, input: spec({ steps: [step('one'), step('two'), step('three')] }) },
  { ruleId: 'unknown-declaration-key', input: spec({ steps: [step('one', { retries: 3 })] }) },
]

test('every rule that means "not answered" makes the run incomplete', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-incomplete-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  for (const testCase of CASES) {
    await t.test(testCase.ruleId, async () => {
      const result = testCase.missing === true
        ? await validateWorkflowFile(join(directory, 'absent.json'))
        : analyzeWorkflow({
          bytes: testCase.bytes === undefined ? encode(testCase.input) : new Uint8Array(testCase.bytes),
          ...(testCase.limits === undefined ? {} : { limits: testCase.limits }),
        })
      const { report, contract } = result
      assert.ok(
        report.findings.some((finding) => finding.ruleId === testCase.ruleId),
        `the fixture did not raise ${testCase.ruleId}`,
      )
      assert.equal(report.status, 'incomplete', `${testCase.ruleId} reported a verdict about evidence it did not have`)
      assert.equal(contract.complete, false)
      if (testCase.errors !== undefined) {
        assert.equal(report.summary.errors, testCase.errors, 'this rule is held by nothing but the incompleteness of the run')
      }
    })
  }
})

test('every rule declared to make a run incomplete has a case above', () => {
  assert.deepEqual(CASES.map((testCase) => testCase.ruleId).sort(), [...INCOMPLETE_RULES].sort())
  assert.equal(CASES.length, 25)
})

test('a run that is incomplete is never a pass, whatever else it found', () => {
  // A clean workflow with one unreadable key beside it: everything else checks
  // out, and the run still refuses to call that a pass.
  const { report } = analyzeWorkflow({
    bytes: encode({
      schemaVersion: '1',
      provided: [{ name: 'seed', type: 'A' }],
      exports: [{ name: 'out', type: 'B' }],
      steps: [{ id: 'one', version: '1.0.0', retries: 3, inputs: [{ name: 'seed', type: 'A' }], outputs: [{ name: 'out', type: 'B' }] }],
    }),
  })
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['unknown-declaration-key'])
  assert.equal(report.summary.checked, 1)
  assert.equal(report.status, 'incomplete')
})
