import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeWorkflow } from '../src/index.mjs'

/**
 * The acceptance evidence, driven through the real entry point.
 *
 * A missing producer and an incompatible consumer must fail *before* anything
 * runs, cycles must be reported rather than hung on, and the optional case
 * must be decided the right way round in both directions.
 */

function run(spec, options = {}) {
  return analyzeWorkflow({ bytes: new TextEncoder().encode(JSON.stringify(spec)), ...options })
}

const rules = (report) => report.findings.map((finding) => finding.ruleId)

const step = (id, extra = {}) => ({ id, version: '1.0.0', ...extra })

test('a fully wired workflow passes and carries an ordered contract', () => {
  const { report, contract } = run({
    schemaVersion: '1',
    workflow: 'demo',
    provided: [{ name: 'seed', type: 'string' }],
    exports: [{ name: 'result', type: 'Result' }],
    steps: [
      step('second', { inputs: [{ name: 'middle', type: 'Middle' }], outputs: [{ name: 'result', type: 'Result' }] }),
      step('first', { inputs: [{ name: 'seed', type: 'string' }], outputs: [{ name: 'middle', type: 'Middle' }] }),
    ],
  })
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.bindings, 3)
  assert.equal(report.summary.unbound, 0)
  assert.deepEqual(contract.order, [{ stage: 0, steps: ['first'] }, { stage: 1, steps: ['second'] }])
  assert.equal(contract.complete, true)
})

test('a consumer whose channel no step produces fails', () => {
  const { report, contract } = run({
    schemaVersion: '1',
    steps: [step('a', { inputs: [{ name: 'ghost', type: 'string' }] })],
  })
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['missing-producer'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.findings[0].location.pointer, '/steps/a/inputs/ghost')
  assert.equal(report.summary.unbound, 1)
  assert.deepEqual(contract.steps[0].consumes, [{
    name: 'ghost',
    type: 'string',
    optional: false,
    minVersion: null,
    from: null,
    resolved: false,
  }])
})

test('a workflow export with no producer fails in the same way', () => {
  const { report } = run({
    schemaVersion: '1',
    exports: [{ name: 'result', type: 'Result' }],
    steps: [step('a')],
  })
  assert.deepEqual(rules(report), ['missing-producer'])
  assert.equal(report.findings[0].location.pointer, '/exports/result')
  assert.match(report.findings[0].message, /^The workflow export consumes channel "result"/)
})

test('an optional consumer whose channel nobody produces still fails', () => {
  // The optionality matrix decides what happens once a producer exists. It does
  // not excuse a producer that is absent: an optional input still names a
  // channel, and a channel no step declares is a wiring mistake whichever way
  // the consumer copes with a missing value. Suppressing the finding here would
  // turn a documented failure into a green pass.
  const { report, contract } = run({
    schemaVersion: '1',
    exports: [{ name: 'phantom', type: 'string', optional: true }],
    steps: [
      step('a', { outputs: [{ name: 'real', type: 'string' }] }),
      step('b', {
        inputs: [
          { name: 'real', type: 'string' },
          { name: 'ghost', type: 'string', optional: true },
        ],
      }),
    ],
  })
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['missing-producer', 'missing-producer'])
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
    '/exports/phantom',
    '/steps/b/inputs/ghost',
  ])
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.unbound, 2)
  assert.deepEqual(contract.steps.find((entry) => entry.id === 'b').consumes[1], {
    name: 'ghost',
    type: 'string',
    optional: true,
    minVersion: null,
    from: null,
    resolved: false,
  })
  assert.deepEqual(contract.exports, [
    { name: 'phantom', type: 'string', optional: true, minVersion: null, from: null, resolved: false },
  ])
})

test('a consumer whose declared type disagrees with the producer fails', () => {
  const { report } = run({
    schemaVersion: '1',
    steps: [
      step('a', { outputs: [{ name: 'x', type: 'Order' }] }),
      step('b', { inputs: [{ name: 'x', type: 'OrderRecord' }] }),
    ],
  })
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['type-incompatible'])
  assert.match(report.findings[0].message, /declares channel "x" as OrderRecord, but a produces it as Order/)
})

test('two type names that differ are never assumed to mean the same type', () => {
  const { report } = run({
    schemaVersion: '1',
    steps: [
      step('a', { outputs: [{ name: 'x', type: 'string' }] }),
      step('b', { inputs: [{ name: 'x', type: 'String' }] }),
    ],
  })
  assert.deepEqual(rules(report), ['type-incompatible'], 'case-insensitive type matching would hide a real mismatch')
})

test('an optional output against a required input fails; against an optional input it passes', () => {
  const optionalProducer = {
    schemaVersion: '1',
    steps: [
      step('a', { outputs: [{ name: 'x', type: 'string', optional: true }] }),
      step('b', { inputs: [{ name: 'x', type: 'string' }] }),
    ],
  }
  const strict = run(optionalProducer)
  assert.equal(strict.report.status, 'fail')
  assert.deepEqual(rules(strict.report), ['optional-output-required-input'])
  assert.match(strict.report.findings[0].message, /only optionally produces it/)

  const tolerant = run({
    schemaVersion: '1',
    steps: [
      step('a', { outputs: [{ name: 'x', type: 'string', optional: true }] }),
      step('b', { inputs: [{ name: 'x', type: 'string', optional: true }] }),
    ],
  })
  assert.equal(tolerant.report.status, 'pass')
  assert.deepEqual(tolerant.report.findings, [])

  // The asymmetry is the point: a producer that always emits satisfies a
  // consumer that could have coped without it.
  const surplus = run({
    schemaVersion: '1',
    steps: [
      step('a', { outputs: [{ name: 'x', type: 'string' }] }),
      step('b', { inputs: [{ name: 'x', type: 'string', optional: true }] }),
    ],
  })
  assert.equal(surplus.report.status, 'pass')
  assert.deepEqual(surplus.report.findings, [])
})

test('a cycle is reported, and every step behind it is reported too', () => {
  const { report, contract } = run({
    schemaVersion: '1',
    steps: [
      step('a', { requires: ['b'] }),
      step('b', { requires: ['c'] }),
      step('c', { requires: ['b'] }),
    ],
  })
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['step-unschedulable', 'dependency-cycle'])
  assert.match(report.findings[1].message, /b -> c -> b/)
  assert.deepEqual(contract.order, [])
  assert.deepEqual(contract.unresolved, ['a', 'b', 'c'])
  assert.equal(report.summary.cycles, 1)
})

test('a cycle formed by data flow alone is found without any requires', () => {
  const { report } = run({
    schemaVersion: '1',
    steps: [
      step('a', { inputs: [{ name: 'y', type: 'string' }], outputs: [{ name: 'x', type: 'string' }] }),
      step('b', { inputs: [{ name: 'x', type: 'string' }], outputs: [{ name: 'y', type: 'string' }] }),
    ],
  })
  assert.deepEqual(rules(report), ['dependency-cycle'])
  assert.match(report.findings[0].message, /a -> b -> a/)
})

test('a channel with two producers is ambiguous, not a merge', () => {
  const { report, contract } = run({
    schemaVersion: '1',
    steps: [
      step('a', { outputs: [{ name: 'x', type: 'string' }] }),
      step('b', { outputs: [{ name: 'x', type: 'string' }] }),
      step('c', { inputs: [{ name: 'x', type: 'string' }] }),
    ],
  })
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['duplicate-producer'])
  assert.equal(report.findings[0].location.pointer, '/steps/b/outputs/x')
  assert.equal(contract.channels[0].producers, 2)
})

test('version constraints are checked against the producing step', () => {
  const build = (producerVersion, minVersion) => run({
    schemaVersion: '1',
    steps: [
      { id: 'a', version: producerVersion, outputs: [{ name: 'x', type: 'string' }] },
      { id: 'b', version: '1.0.0', inputs: [{ name: 'x', type: 'string', minVersion }] },
    ],
  })
  assert.deepEqual(rules(build('2.1.0', '2.0.0').report), [])
  assert.deepEqual(rules(build('2.0.0', '2.0.0').report), [])
  assert.deepEqual(rules(build('1.4.0', '1.5.0').report), ['producer-version-too-low'])
  assert.deepEqual(rules(build('1.4.0', '1.4.1').report), ['producer-version-too-low'])
  // A newer major version is a breaking change, not a satisfied minimum.
  assert.deepEqual(rules(build('3.0.0', '2.0.0').report), ['producer-major-mismatch'])
  assert.deepEqual(rules(build('1.0.0', '2.0.0').report), ['producer-major-mismatch'])

  // The 0.x case, where this rule is deliberately not npm's caret: `^0.1.0`
  // admits only 0.1.x, and here the major version carries the whole of the
  // compatibility claim, so 0.9.0 satisfies a 0.1.0 minimum and 1.0.0 does not.
  assert.deepEqual(rules(build('0.9.0', '0.1.0').report), [])
  assert.deepEqual(rules(build('0.1.0', '0.9.0').report), ['producer-version-too-low'])
  assert.deepEqual(rules(build('1.0.0', '0.1.0').report), ['producer-major-mismatch'])
})

test('a version constraint that could not be checked is unknown, not satisfied', () => {
  const { report } = run({
    schemaVersion: '1',
    provided: [{ name: 'x', type: 'string' }],
    steps: [step('b', { inputs: [{ name: 'x', type: 'string', minVersion: '2.0.0' }] })],
  })
  assert.deepEqual(rules(report), ['producer-version-unknown'])
  assert.equal(report.findings[0].severity, 'warning')
  // A warning alone would leave this green. Unknown evidence is never a pass.
  assert.equal(report.status, 'incomplete')
})

test('a workflow with no steps is incomplete, never a pass on no evidence', () => {
  const { report } = run({ schemaVersion: '1', steps: [] })
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(rules(report), ['no-steps-declared'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.status, 'incomplete')
})

test('declarations nothing uses are information, and do not fail the run', () => {
  const { report } = run({
    schemaVersion: '1',
    provided: [{ name: 'unused', type: 'string' }],
    steps: [step('a', { outputs: [{ name: 'spare', type: 'string' }] })],
  })
  assert.equal(report.status, 'pass')
  assert.deepEqual(rules(report), ['provided-unused', 'output-unconsumed'])
  assert.deepEqual(report.findings.map((finding) => finding.severity), ['info', 'info'])
})

test('configuration errors throw, so the CLI can report them with no report at all', () => {
  const bytes = new TextEncoder().encode('{}')
  assert.throws(() => analyzeWorkflow({ bytes, sources: 'x' }), /Unknown option "sources"/)
  assert.throws(() => analyzeWorkflow({ bytes, limits: { maxStep: 1 } }), /Unknown limit "maxStep"/)
  assert.throws(() => analyzeWorkflow({ bytes, clock: 5 }), /clock must be a function/)
  assert.throws(() => analyzeWorkflow({ bytes, clock: () => 'now' }), /finite number/)
  assert.throws(() => analyzeWorkflow(null), /Options must be an object/)
})

test('the time budget is checked while the run is in progress, not only at its start', () => {
  const spec = {
    schemaVersion: '1',
    steps: [step('a', { outputs: [{ name: 'x', type: 'string' }] }), step('b', { inputs: [{ name: 'x', type: 'string' }] })],
  }
  // The clock is injected, so "slow" is a fact of the test rather than of the
  // host. The first readings are inside the budget; a later one is not.
  let reading = 0
  const readings = [0, 0, 0, 9000]
  const clock = () => (reading < readings.length ? readings[reading++] : 9000)
  const { report } = run(spec, { clock, limits: { maxMillis: 1000 } })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['time-budget-exceeded'])
  assert.equal(report.summary.checked, 2, 'the run stopped before it had read the steps at all')
})
