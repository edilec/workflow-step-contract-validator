import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')

/**
 * Severity, pinned by what a run of the tool actually does.
 *
 * `RULE_SEVERITY` is the single source of truth and stays that way. What it
 * cannot do is defend itself: asserting the table against the documented
 * catalog, or against a copy of the same values written out by hand in a test,
 * is three declarations agreeing with each other, and one coordinated edit
 * satisfies all three. A tool in this catalog had forty error rules survive
 * exactly that flip.
 *
 * So every rule below is driven through the real command line on a real
 * specification, and what is asserted is the outcome:
 *
 * - the **exit code**, which no edit to a table can change;
 * - the **status** the report declares;
 * - the exact set of rule ids the run emitted, so a fixture cannot be carried
 *   by some other rule's severity;
 * - the **severity word the human report prints**, read off stdout;
 * - `summary.errors`, as a literal count.
 *
 * For the eleven rules that do not make a run incomplete, a downgrade moves the
 * exit code: an error that becomes a warning turns fail/1 into pass/0, and an
 * info that becomes an error turns pass/0 into fail/1. For the twenty-five that
 * do make it incomplete the exit code is 2 whatever the severity, so those are
 * held by the printed severity word and the literal error count instead.
 *
 * The expectations here are written out one by one on purpose. There is no map
 * shared with the source, the documentation or any other test.
 */

const VALID = { id: 'kept', version: '1.0.0' }
const spec = (extra) => ({ schemaVersion: '1', ...extra })
const step = (id, extra = {}) => ({ id, version: '1.0.0', ...extra })

const CASES = [
  {
    ruleId: 'dependency-cycle',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 1,
    rules: ['dependency-cycle'],
    spec: spec({ steps: [step('a', { requires: ['b'] }), step('b', { requires: ['a'] })] }),
  },
  {
    ruleId: 'dependency-malformed',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['dependency-malformed'],
    spec: spec({ steps: [step('a', { requires: [7] })] }),
  },
  {
    ruleId: 'duplicate-producer',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 1,
    rules: ['duplicate-producer'],
    spec: spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string' }] }),
        step('b', { outputs: [{ name: 'x', type: 'string' }] }),
        step('c', { inputs: [{ name: 'x', type: 'string' }] }),
      ],
    }),
  },
  {
    ruleId: 'graph-budget-exceeded',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['graph-budget-exceeded'],
    flags: ['--max-graph-operations', '1'],
    spec: spec({ steps: [step('a'), step('b', { requires: ['a'] }), step('c', { requires: ['b'] })] }),
  },
  {
    ruleId: 'graph-too-deep',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['graph-too-deep'],
    flags: ['--max-depth', '1'],
    spec: spec({ steps: [step('a'), step('b', { requires: ['a'] })] }),
  },
  {
    ruleId: 'missing-producer',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 1,
    rules: ['missing-producer'],
    spec: spec({ steps: [step('a', { inputs: [{ name: 'ghost', type: 'string' }] })] }),
  },
  {
    ruleId: 'no-steps-declared',
    severity: 'warning',
    status: 'incomplete',
    exit: 2,
    errors: 0,
    rules: ['no-steps-declared'],
    spec: spec({ steps: [] }),
  },
  {
    ruleId: 'optional-output-required-input',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 1,
    rules: ['optional-output-required-input'],
    spec: spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string', optional: true }] }),
        step('b', { inputs: [{ name: 'x', type: 'string' }] }),
      ],
    }),
  },
  {
    ruleId: 'output-unconsumed',
    severity: 'info',
    status: 'pass',
    exit: 0,
    errors: 0,
    rules: ['output-unconsumed'],
    spec: spec({ steps: [step('a', { outputs: [{ name: 'x', type: 'string' }] })] }),
  },
  {
    ruleId: 'port-duplicated',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['port-duplicated'],
    spec: spec({
      provided: [{ name: 'x', type: 'string' }],
      steps: [step('a', { inputs: [{ name: 'x', type: 'string' }, { name: 'x', type: 'string' }] })],
    }),
  },
  {
    ruleId: 'port-malformed',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['port-malformed'],
    spec: spec({
      provided: [{ name: 'x', type: 'string' }],
      steps: [step('a', { inputs: [{ name: 'x', type: 'string', optional: 'yes' }] })],
    }),
  },
  {
    ruleId: 'port-name-invalid',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['port-name-invalid'],
    spec: spec({ steps: [step('a', { inputs: [{ type: 'string' }] })] }),
  },
  {
    ruleId: 'port-type-invalid',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['port-type-invalid'],
    spec: spec({
      provided: [{ name: 'x', type: 'string' }],
      steps: [step('a', { inputs: [{ name: 'x' }] })],
    }),
  },
  {
    ruleId: 'producer-major-mismatch',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 1,
    rules: ['producer-major-mismatch'],
    spec: spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string' }] }),
        step('b', { inputs: [{ name: 'x', type: 'string', minVersion: '2.0.0' }] }),
      ],
    }),
  },
  {
    ruleId: 'producer-version-too-low',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 1,
    rules: ['producer-version-too-low'],
    spec: spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string' }] }),
        step('b', { inputs: [{ name: 'x', type: 'string', minVersion: '1.5.0' }] }),
      ],
    }),
  },
  {
    ruleId: 'producer-version-unknown',
    severity: 'warning',
    status: 'incomplete',
    exit: 2,
    errors: 0,
    rules: ['producer-version-unknown'],
    spec: spec({
      provided: [{ name: 'x', type: 'string' }],
      steps: [step('a', { inputs: [{ name: 'x', type: 'string', minVersion: '1.0.0' }] })],
    }),
  },
  {
    ruleId: 'provided-unused',
    severity: 'info',
    status: 'pass',
    exit: 0,
    errors: 0,
    rules: ['provided-unused'],
    spec: spec({ provided: [{ name: 'x', type: 'string' }], steps: [VALID] }),
  },
  {
    ruleId: 'spec-malformed',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['spec-malformed'],
    spec: { schemaVersion: '2', steps: [] },
  },
  {
    ruleId: 'spec-not-json',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['spec-not-json'],
    text: '{ this is not json',
  },
  {
    ruleId: 'spec-not-utf8',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['spec-not-utf8'],
    bytes: [0x7b, 0x22, 0xff, 0x22, 0x7d],
  },
  {
    ruleId: 'spec-too-large',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['spec-too-large'],
    flags: ['--max-bytes', '10'],
    spec: spec({ steps: [VALID] }),
  },
  {
    ruleId: 'spec-unreadable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['spec-unreadable'],
    missing: true,
  },
  {
    ruleId: 'step-id-duplicated',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['step-id-duplicated'],
    spec: spec({ steps: [step('a'), step('a')] }),
  },
  {
    ruleId: 'step-id-invalid',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['step-id-invalid'],
    spec: spec({ steps: [{ id: '1bad', version: '1.0.0' }] }),
  },
  {
    ruleId: 'step-malformed',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['step-malformed'],
    spec: spec({ steps: [7] }),
  },
  {
    ruleId: 'step-unschedulable',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 2,
    rules: ['dependency-cycle', 'step-unschedulable'],
    spec: spec({ steps: [step('a', { requires: ['b'] }), step('b', { requires: ['c'] }), step('c', { requires: ['b'] })] }),
  },
  {
    ruleId: 'step-version-invalid',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['step-version-invalid'],
    spec: spec({ steps: [{ id: 'a', version: '1.0' }] }),
  },
  {
    ruleId: 'time-budget-exceeded',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['time-budget-exceeded'],
    flags: ['--max-millis', '0'],
    spec: spec({ steps: [VALID] }),
  },
  {
    ruleId: 'too-many-dependencies',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['too-many-dependencies'],
    flags: ['--max-dependencies-per-step', '1'],
    spec: spec({ steps: [step('a', { requires: ['b', 'c'] }), step('b'), step('c')] }),
  },
  {
    ruleId: 'too-many-exports',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['too-many-exports'],
    flags: ['--max-exports', '1'],
    spec: spec({ exports: [{ name: 'x', type: 'string' }, { name: 'y', type: 'string' }], steps: [VALID] }),
  },
  {
    ruleId: 'too-many-ports',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['too-many-ports'],
    flags: ['--max-ports-per-step', '1'],
    spec: spec({
      steps: [step('a', { inputs: [{ name: 'x', type: 'string' }], outputs: [{ name: 'y', type: 'string' }] })],
    }),
  },
  {
    ruleId: 'too-many-provided',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['too-many-provided'],
    flags: ['--max-provided', '1'],
    spec: spec({ provided: [{ name: 'x', type: 'string' }, { name: 'y', type: 'string' }], steps: [VALID] }),
  },
  {
    ruleId: 'too-many-steps',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['too-many-steps'],
    flags: ['--max-steps', '1'],
    spec: spec({ steps: [step('a'), step('b')] }),
  },
  {
    ruleId: 'type-incompatible',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 1,
    rules: ['type-incompatible'],
    spec: spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string' }] }),
        step('b', { inputs: [{ name: 'x', type: 'number' }] }),
      ],
    }),
  },
  {
    ruleId: 'unknown-declaration-key',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    errors: 1,
    rules: ['unknown-declaration-key'],
    spec: { schemaVersion: '1', stpes: [], steps: [VALID] },
  },
  {
    ruleId: 'unknown-dependency',
    severity: 'error',
    status: 'fail',
    exit: 1,
    errors: 1,
    rules: ['unknown-dependency'],
    spec: spec({ steps: [step('a', { requires: ['ghost'] })] }),
  },
]

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

test('every rule is pinned by the outcome of a real run', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-severity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  for (const testCase of CASES) {
    await t.test(testCase.ruleId, async () => {
      const specPath = join(directory, `${testCase.ruleId}.json`)
      if (testCase.bytes !== undefined) await writeFile(specPath, Buffer.from(testCase.bytes))
      else if (testCase.text !== undefined) await writeFile(specPath, testCase.text, 'utf8')
      else if (testCase.missing !== true) await writeFile(specPath, JSON.stringify(testCase.spec), 'utf8')

      const flags = testCase.flags ?? []
      const machine = await runCli(['--spec', specPath, '--json', ...flags])
      assert.equal(machine.code, testCase.exit, 'the exit code moved')
      const report = JSON.parse(machine.stdout)
      assert.equal(report.status, testCase.status)
      assert.deepEqual([...new Set(report.findings.map((finding) => finding.ruleId))].sort(), testCase.rules)
      assert.equal(report.summary.errors, testCase.errors)
      const finding = report.findings.find((entry) => entry.ruleId === testCase.ruleId)
      assert.equal(finding.severity, testCase.severity)

      // The word a person reads, off the real stdout of the real command.
      const human = await runCli(['--spec', specPath, ...flags])
      assert.equal(human.code, testCase.exit)
      const line = human.stdout.split('\n').find((entry) => entry.includes(` ${testCase.ruleId} `))
      assert.equal(line.startsWith(testCase.severity.toUpperCase()), true, `printed as: ${line}`)
    })
  }
})

test('every rule in the table has a case above', () => {
  assert.deepEqual(CASES.map((testCase) => testCase.ruleId).sort(), Object.keys(RULE_SEVERITY).sort())
  assert.equal(CASES.length, 36)
})
