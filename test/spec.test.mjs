import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIMITS,
  compareVersions,
  normalizeSpec,
  parseVersion,
  readSpecDocument,
  validateLimits,
} from '../src/spec.mjs'

const encode = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const ruleIds = (problems) => problems.map((problem) => problem.ruleId).sort()

test('a limit override must be known and must be an integer', () => {
  assert.deepEqual(validateLimits({}), DEFAULT_LIMITS)
  assert.equal(validateLimits({ maxSteps: 3 }).maxSteps, 3)
  // A typo that is silently ignored leaves the default in force while the
  // operator believes a stricter bound is being enforced.
  assert.throws(() => validateLimits({ maxStep: 3 }), /Unknown limit "maxStep"/)
  assert.throws(() => validateLimits({ maxSteps: 0 }), /at least 1/)
  assert.throws(() => validateLimits({ maxSteps: 2.5 }), /at least 1/)
  assert.throws(() => validateLimits({ maxSteps: '3' }), /at least 1/)
  assert.throws(() => validateLimits(null), /Limits must be an object/)
  // The time budget is the one limit allowed to be zero.
  assert.equal(validateLimits({ maxMillis: 0 }).maxMillis, 0)
  assert.throws(() => validateLimits({ maxMillis: -1 }), /at least 0/)
})

test('the document is read by bytes, then decoded strictly, then parsed', () => {
  const limits = validateLimits({})
  assert.equal(readSpecDocument(encode({ schemaVersion: '1', steps: [] }), limits).ok, true)

  const tooLarge = readSpecDocument(encode({ schemaVersion: '1', steps: [] }), validateLimits({ maxBytes: 4 }))
  assert.equal(tooLarge.ruleId, 'spec-too-large')
  assert.match(tooLarge.message, /over the maxBytes budget of 4/)

  assert.equal(readSpecDocument(new Uint8Array([0x7b, 0xff, 0x7d]), limits).ruleId, 'spec-not-utf8')
  assert.equal(readSpecDocument(encode('{ not json'), limits).ruleId, 'spec-not-json')
  assert.throws(() => readSpecDocument('{}', limits), /must be a Uint8Array/)
})

test('versions are parsed strictly and compared numerically', () => {
  assert.deepEqual(parseVersion('2.10.3'), [2, 10, 3])
  // A version this tool cannot compare is refused rather than guessed at.
  for (const value of ['1.0', '1.0.0-rc.1', '1.0.0+build', 'v1.0.0', '01.0.0', 1, null]) {
    assert.equal(parseVersion(value), null, `${String(value)} was parsed as a version`)
  }
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0)
  assert.equal(compareVersions([1, 2, 3], [1, 10, 0]) < 0, true)
  assert.equal(compareVersions([2, 0, 0], [1, 99, 99]) > 0, true)
})

test('a document-level limit refuses the document instead of truncating it', () => {
  const spec = { schemaVersion: '1', steps: [{ id: 'a', version: '1.0.0' }, { id: 'b', version: '1.0.0' }] }
  const result = normalizeSpec(spec, validateLimits({ maxSteps: 1 }))
  assert.equal(result.stopped, true)
  assert.deepEqual(result.steps, [], 'the first step was analysed anyway, which is a truncated answer')
  assert.deepEqual(ruleIds(result.problems), ['too-many-steps'])
  assert.equal(result.declaredSteps, 2)
})

test('a step-level limit refuses the step instead of truncating it', () => {
  const spec = {
    schemaVersion: '1',
    steps: [{
      id: 'a',
      version: '1.0.0',
      inputs: [{ name: 'x', type: 'string' }, { name: 'y', type: 'string' }],
      outputs: [{ name: 'z', type: 'string' }],
    }],
  }
  const result = normalizeSpec(spec, validateLimits({ maxPortsPerStep: 2 }))
  assert.equal(result.stopped, false)
  assert.deepEqual(result.steps, [])
  assert.deepEqual(ruleIds(result.problems), ['too-many-ports'])
})

test('an unreadable declaration is reported, never defaulted', () => {
  const spec = {
    schemaVersion: '1',
    stpes: [],
    steps: [
      42,
      { id: '1nope', version: '1.0.0' },
      { id: 'a', version: '1.0' },
      { id: 'a', version: '1.0.0' },
      {
        id: 'b',
        version: '1.0.0',
        requires: ['ok', 7],
        inputs: [
          { name: 'x', type: 'string', optional: 'yes' },
          { name: 'x', type: 'string' },
          { name: 'y' },
          { type: 'string' },
          17,
          { name: 'z', type: 'string', optionl: true },
        ],
      },
      { id: 'ok', version: '1.0.0', extra: true },
    ],
  }
  const result = normalizeSpec(spec, validateLimits({}))
  assert.deepEqual(ruleIds(result.problems), [
    'dependency-malformed',
    'port-duplicated',
    'port-malformed',
    'port-malformed',
    'port-name-invalid',
    'port-type-invalid',
    'step-id-duplicated',
    'step-id-invalid',
    'step-malformed',
    'step-version-invalid',
    'unknown-declaration-key',
    'unknown-declaration-key',
    'unknown-declaration-key',
  ])
  assert.deepEqual(result.steps.map((step) => step.id), ['a', 'b', 'ok'])
  // The step whose version could not be read is kept, with no version: the
  // binding it takes part in is still a fact, the version check is not.
  assert.equal(result.steps[0].version, null)
  assert.deepEqual(result.steps[1].requires, ['ok'])
  // A port whose type could not be read keeps its name, so the binding is
  // still reported; only the comparison it could not support is skipped.
  assert.deepEqual(result.steps[1].inputs.map((port) => [port.name, port.type]), [['x', 'string'], ['y', null], ['z', 'string']])
})

test('the root shape decides whether anything can be analysed at all', () => {
  for (const spec of [null, [], 'workflow', 7]) {
    const result = normalizeSpec(spec, validateLimits({}))
    assert.equal(result.stopped, true)
    assert.deepEqual(ruleIds(result.problems), ['spec-malformed'])
  }
  const wrongVersion = normalizeSpec({ schemaVersion: '2', steps: [] }, validateLimits({}))
  assert.equal(wrongVersion.stopped, true)
  assert.match(wrongVersion.problems[0].message, /this tool reads version "1"/)

  const noSteps = normalizeSpec({ schemaVersion: '1' }, validateLimits({}))
  assert.equal(noSteps.stopped, true)
  assert.deepEqual(ruleIds(noSteps.problems), ['spec-malformed'])
})
