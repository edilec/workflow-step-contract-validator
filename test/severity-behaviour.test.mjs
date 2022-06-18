import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')

/**
 * Severity, pinned by what a run of the tool actually does.
 *
 * `RULE_SEVERITY` is the single source of truth and stays that way. What it
 * cannot do is defend itself. Asserting the table against the documented
 * catalog, or against a copy of the same values written out by hand in a test,
 * is three declarations agreeing with each other, and one coordinated edit
 * satisfies all three.
 *
 * A behavioural test can be a fourth mirror, and this file used to be one. It
 * drove the real command line, but every expectation it compared against came
 * out of a table of cases that the same edit touches. Flipping a rule to
 * `warning` in the frozen table, in the documented catalog and in that table of
 * cases left 26 of the 32 error rules green.
 *
 * So this file shares nothing. It imports nothing from `src/`. There is no
 * table of cases, no expectation computed from one, and no expectation named
 * once and reused. Every rule below is a separate test that runs the real
 * command line over a real specification and states its outcome as a literal:
 *
 * - the **exit code**, which no edit to a table can change;
 * - the **status** the report declares;
 * - the exact set of rule ids the run emitted, so a fixture cannot be carried
 *   by some other rule;
 * - `errors`, `warnings` and `info`, as literal counts;
 * - the **severity word the human report prints**, read off stdout.
 *
 * For a rule that also marks the run incomplete the exit code is 2 whatever the
 * severity, so there the literal counts and the printed word are what hold it:
 * downgrade `spec-not-json` to a warning and `errors` goes from 1 to 0,
 * `warnings` from 0 to 1, and the line a person reads starts with WARNING.
 *
 * `test/severity-table.test.mjs` checks that every rule in the table has a case
 * here, so a rule cannot be added without one.
 */

const VALID = { id: 'kept', version: '1.0.0' }
const spec = (extra) => ({ schemaVersion: '1', ...extra })
const step = (id, extra = {}) => ({ id, version: '1.0.0', ...extra })
const json = (value) => JSON.stringify(value)

let workspace = null
function directory() {
  if (workspace === null) workspace = mkdtemp(join(tmpdir(), 'workflow-contract-severity-'))
  return workspace
}
after(async () => {
  if (workspace !== null) await rm(await workspace, { recursive: true, force: true })
})

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

/**
 * Run one specification through the real command line, twice: once for the
 * machine-readable report and once for the words a person reads.
 *
 * Nothing here carries an expectation. It writes the bytes, runs the binary and
 * hands back what came out; every expectation is written inline at its
 * assertion, in the test that makes it. A `null` document is a specification
 * that was never written, which is how the unreadable case is reached.
 */
async function run(name, document, flags = []) {
  const specPath = join(await directory(), `${name}.json`)
  if (document !== null) await writeFile(specPath, document)
  const machine = await runCli(['--spec', specPath, '--json', ...flags])
  const human = await runCli(['--spec', specPath, ...flags])
  const report = JSON.parse(machine.stdout)
  return {
    exitCode: machine.code,
    humanExitCode: human.code,
    report,
    rules: [...new Set(report.findings.map((finding) => finding.ruleId))].sort(),
    line: (ruleId) => human.stdout.split('\n').find((entry) => entry.includes(` ${ruleId} `)) ?? '',
  }
}

test('dependency-cycle is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'dependency-cycle',
    json(spec({ steps: [step('a', { requires: ['b'] }), step('b', { requires: ['a'] })] })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['dependency-cycle'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('dependency-cycle').startsWith('ERROR'), true, outcome.line('dependency-cycle'))
})

test('dependency-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run('dependency-malformed', json(spec({ steps: [step('a', { requires: [7] })] })))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['dependency-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('dependency-malformed').startsWith('ERROR'), true, outcome.line('dependency-malformed'))
})

test('duplicate-producer is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'duplicate-producer',
    json(spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string' }] }),
        step('b', { outputs: [{ name: 'x', type: 'string' }] }),
        step('c', { inputs: [{ name: 'x', type: 'string' }] }),
      ],
    })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['duplicate-producer'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('duplicate-producer').startsWith('ERROR'), true, outcome.line('duplicate-producer'))
})

test('graph-budget-exceeded is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'graph-budget-exceeded',
    json(spec({ steps: [step('a'), step('b', { requires: ['a'] }), step('c', { requires: ['b'] })] })),
    ['--max-graph-operations', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['graph-budget-exceeded'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('graph-budget-exceeded').startsWith('ERROR'), true, outcome.line('graph-budget-exceeded'))
})

test('graph-too-deep is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'graph-too-deep',
    json(spec({ steps: [step('a'), step('b', { requires: ['a'] })] })),
    ['--max-depth', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['graph-too-deep'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('graph-too-deep').startsWith('ERROR'), true, outcome.line('graph-too-deep'))
})

test('missing-producer is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'missing-producer',
    json(spec({ steps: [step('a', { inputs: [{ name: 'ghost', type: 'string' }] })] })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['missing-producer'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('missing-producer').startsWith('ERROR'), true, outcome.line('missing-producer'))
})

test('no-steps-declared is a warning, and only incompleteness keeps it off a pass', async () => {
  const outcome = await run('no-steps-declared', json(spec({ steps: [] })))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['no-steps-declared'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('no-steps-declared').startsWith('WARNING'), true, outcome.line('no-steps-declared'))
})

test('optional-output-required-input is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'optional-output-required-input',
    json(spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string', optional: true }] }),
        step('b', { inputs: [{ name: 'x', type: 'string' }] }),
      ],
    })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['optional-output-required-input'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('optional-output-required-input').startsWith('ERROR'), true, outcome.line('optional-output-required-input'))
})

test('output-unconsumed is information: the run passes and the command exits 0', async () => {
  const outcome = await run(
    'output-unconsumed',
    json(spec({ steps: [step('a', { outputs: [{ name: 'x', type: 'string' }] })] })),
  )
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.report.status, 'pass')
  assert.deepEqual(outcome.rules, ['output-unconsumed'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 1)
  assert.equal(outcome.humanExitCode, 0)
  assert.equal(outcome.line('output-unconsumed').startsWith('INFO'), true, outcome.line('output-unconsumed'))
})

test('port-duplicated is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'port-duplicated',
    json(spec({
      provided: [{ name: 'x', type: 'string' }],
      steps: [step('a', { inputs: [{ name: 'x', type: 'string' }, { name: 'x', type: 'string' }] })],
    })),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['port-duplicated'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('port-duplicated').startsWith('ERROR'), true, outcome.line('port-duplicated'))
})

test('port-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'port-malformed',
    json(spec({
      provided: [{ name: 'x', type: 'string' }],
      steps: [step('a', { inputs: [{ name: 'x', type: 'string', optional: 'yes' }] })],
    })),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['port-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('port-malformed').startsWith('ERROR'), true, outcome.line('port-malformed'))
})

test('port-name-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'port-name-invalid',
    json(spec({ steps: [step('a', { inputs: [{ type: 'string' }] })] })),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['port-name-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('port-name-invalid').startsWith('ERROR'), true, outcome.line('port-name-invalid'))
})

test('port-type-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'port-type-invalid',
    json(spec({
      provided: [{ name: 'x', type: 'string' }],
      steps: [step('a', { inputs: [{ name: 'x' }] })],
    })),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['port-type-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('port-type-invalid').startsWith('ERROR'), true, outcome.line('port-type-invalid'))
})

test('producer-major-mismatch is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'producer-major-mismatch',
    json(spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string' }] }),
        step('b', { inputs: [{ name: 'x', type: 'string', minVersion: '2.0.0' }] }),
      ],
    })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['producer-major-mismatch'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('producer-major-mismatch').startsWith('ERROR'), true, outcome.line('producer-major-mismatch'))
})

test('producer-version-too-low is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'producer-version-too-low',
    json(spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string' }] }),
        step('b', { inputs: [{ name: 'x', type: 'string', minVersion: '1.5.0' }] }),
      ],
    })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['producer-version-too-low'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('producer-version-too-low').startsWith('ERROR'), true, outcome.line('producer-version-too-low'))
})

test('producer-version-unknown is a warning, and only incompleteness keeps it off a pass', async () => {
  const outcome = await run(
    'producer-version-unknown',
    json(spec({
      provided: [{ name: 'x', type: 'string' }],
      steps: [step('a', { inputs: [{ name: 'x', type: 'string', minVersion: '1.0.0' }] })],
    })),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['producer-version-unknown'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('producer-version-unknown').startsWith('WARNING'), true, outcome.line('producer-version-unknown'))
})

test('provided-unused is information: the run passes and the command exits 0', async () => {
  const outcome = await run(
    'provided-unused',
    json(spec({ provided: [{ name: 'x', type: 'string' }], steps: [VALID] })),
  )
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.report.status, 'pass')
  assert.deepEqual(outcome.rules, ['provided-unused'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 1)
  assert.equal(outcome.humanExitCode, 0)
  assert.equal(outcome.line('provided-unused').startsWith('INFO'), true, outcome.line('provided-unused'))
})

test('spec-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-malformed', json({ schemaVersion: '2', steps: [] }))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-malformed').startsWith('ERROR'), true, outcome.line('spec-malformed'))
})

test('spec-not-json is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-not-json', '{ this is not json')
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-not-json'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-not-json').startsWith('ERROR'), true, outcome.line('spec-not-json'))
})

test('spec-not-utf8 is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-not-utf8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-not-utf8'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-not-utf8').startsWith('ERROR'), true, outcome.line('spec-not-utf8'))
})

test('spec-too-large is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-too-large', json(spec({ steps: [VALID] })), ['--max-bytes', '10'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-too-large'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-too-large').startsWith('ERROR'), true, outcome.line('spec-too-large'))
})

test('spec-unreadable is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-unreadable', null)
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-unreadable'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-unreadable').startsWith('ERROR'), true, outcome.line('spec-unreadable'))
})

test('step-id-duplicated is an error on a run that exits 2 either way', async () => {
  const outcome = await run('step-id-duplicated', json(spec({ steps: [step('a'), step('a')] })))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['step-id-duplicated'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('step-id-duplicated').startsWith('ERROR'), true, outcome.line('step-id-duplicated'))
})

test('step-id-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run('step-id-invalid', json(spec({ steps: [{ id: '1bad', version: '1.0.0' }] })))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['step-id-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('step-id-invalid').startsWith('ERROR'), true, outcome.line('step-id-invalid'))
})

test('step-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run('step-malformed', json(spec({ steps: [7] })))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['step-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('step-malformed').startsWith('ERROR'), true, outcome.line('step-malformed'))
})

test('step-unschedulable is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'step-unschedulable',
    json(spec({ steps: [step('a', { requires: ['b'] }), step('b', { requires: ['c'] }), step('c', { requires: ['b'] })] })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['dependency-cycle', 'step-unschedulable'])
  assert.equal(outcome.report.summary.errors, 2)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('step-unschedulable').startsWith('ERROR'), true, outcome.line('step-unschedulable'))
})

test('step-version-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run('step-version-invalid', json(spec({ steps: [{ id: 'a', version: '1.0' }] })))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['step-version-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('step-version-invalid').startsWith('ERROR'), true, outcome.line('step-version-invalid'))
})

test('time-budget-exceeded is an error on a run that exits 2 either way', async () => {
  const outcome = await run('time-budget-exceeded', json(spec({ steps: [VALID] })), ['--max-millis', '0'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['time-budget-exceeded'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('time-budget-exceeded').startsWith('ERROR'), true, outcome.line('time-budget-exceeded'))
})

test('too-many-dependencies is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-dependencies',
    json(spec({ steps: [step('a', { requires: ['b', 'c'] }), step('b'), step('c')] })),
    ['--max-dependencies-per-step', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-dependencies'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-dependencies').startsWith('ERROR'), true, outcome.line('too-many-dependencies'))
})

test('too-many-exports is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-exports',
    json(spec({ exports: [{ name: 'x', type: 'string' }, { name: 'y', type: 'string' }], steps: [VALID] })),
    ['--max-exports', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-exports'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-exports').startsWith('ERROR'), true, outcome.line('too-many-exports'))
})

test('too-many-ports is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-ports',
    json(spec({
      steps: [step('a', { inputs: [{ name: 'x', type: 'string' }], outputs: [{ name: 'y', type: 'string' }] })],
    })),
    ['--max-ports-per-step', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-ports'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-ports').startsWith('ERROR'), true, outcome.line('too-many-ports'))
})

test('too-many-provided is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-provided',
    json(spec({ provided: [{ name: 'x', type: 'string' }, { name: 'y', type: 'string' }], steps: [VALID] })),
    ['--max-provided', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-provided'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-provided').startsWith('ERROR'), true, outcome.line('too-many-provided'))
})

test('too-many-steps is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-steps',
    json(spec({ steps: [step('a'), step('b')] })),
    ['--max-steps', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-steps'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-steps').startsWith('ERROR'), true, outcome.line('too-many-steps'))
})

test('type-incompatible is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'type-incompatible',
    json(spec({
      steps: [
        step('a', { outputs: [{ name: 'x', type: 'string' }] }),
        step('b', { inputs: [{ name: 'x', type: 'number' }] }),
      ],
    })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['type-incompatible'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('type-incompatible').startsWith('ERROR'), true, outcome.line('type-incompatible'))
})

test('unknown-declaration-key is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'unknown-declaration-key',
    json({ schemaVersion: '1', stpes: [], steps: [VALID] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['unknown-declaration-key'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('unknown-declaration-key').startsWith('ERROR'), true, outcome.line('unknown-declaration-key'))
})

test('unknown-dependency is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('unknown-dependency', json(spec({ steps: [step('a', { requires: ['ghost'] })] })))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['unknown-dependency'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('unknown-dependency').startsWith('ERROR'), true, outcome.line('unknown-dependency'))
})
