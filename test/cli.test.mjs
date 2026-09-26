import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')
const clean = join(projectDirectory, 'examples', 'order-fulfilment.json')
const broken = join(projectDirectory, 'examples', 'broken-workflow.json')

async function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory, ...options })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

async function temporary(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('--help explains the tool and exits 0', async () => {
  const result = await runCli(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /Usage:\n {2}workflow-step-contract-validator --spec FILE/)
  assert.match(result.stdout, /--max-millis N/)
  assert.equal(result.stderr, '')
})

test('a configuration error leaves stdout empty', async () => {
  // The run never had a subject, so there is nothing to report about. A
  // consumer piping stdout must see nothing rather than a fabricated report.
  for (const args of [
    ['--spec', clean, '--wat'],
    [],
    ['--spec'],
    ['--spec', clean, '--spec', broken],
    ['--spec', clean, '--json', '--json'],
    ['--spec', clean, '--max-steps', '0'],
    ['--spec', clean, '--max-steps', 'many'],
    ['--spec', clean, '--max-millis', '-1'],
  ]) {
    const result = await runCli(args)
    assert.equal(result.code, 2, `${args.join(' ')} should be a configuration error`)
    assert.equal(result.stdout, '', `${args.join(' ')} wrote a report for a run that never started`)
    assert.notEqual(result.stderr, '')
  }
})

test('an input that could not be read is reported, not passed over', async () => {
  const result = await runCli(['--spec', join(projectDirectory, 'examples', 'nothing-here.json'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['spec-unreadable'])
  assert.match(report.findings[0].message, /ENOENT/)
  // The label is relative, never the absolute path the process happened to use.
  assert.equal(report.findings[0].location.file, 'examples/nothing-here.json')
})

test('the clean example passes and the broken example fails', async () => {
  const passed = await runCli(['--spec', clean])
  assert.equal(passed.code, 0)
  assert.match(passed.stdout, /status pass/)
  assert.match(passed.stdout, /order: \[0\] fetch-order \| \[1\] check-stock, price-order \| \[2\] notify-backorder \| \[3\] ship/)

  const failed = await runCli(['--spec', broken, '--json'])
  assert.equal(failed.code, 1)
  const report = JSON.parse(failed.stdout)
  assert.equal(report.status, 'fail')
  assert.deepEqual([...new Set(report.findings.map((finding) => finding.ruleId))].sort(), [
    'dependency-cycle',
    'duplicate-producer',
    'missing-producer',
    'optional-output-required-input',
    'producer-major-mismatch',
    'type-incompatible',
    'unknown-dependency',
  ])
})

test('every worked example in the README is the real output of the command beside it', async () => {
  // One of these blocks used to show three of the seven findings, with no
  // ellipsis and neither summary line, so a reader comparing their own run
  // against it would think the tool had changed under them.
  const text = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  const worked = [...text.matchAll(/```sh\n(workflow-step-contract-validator [^\n]*)\n```\n\n```\n([\s\S]*?)```\n/g)]
  assert.equal(worked.length, 2, 'the README worked examples moved or lost their output block')
  for (const [, command, shown] of worked) {
    const result = await runCli(command.split(' ').slice(1))
    assert.equal(result.stdout, shown, `the README block for "${command}" is not what the command prints`)
  }
})

test('stdout carries the report and nothing else', async () => {
  const result = await runCli(['--spec', clean, '--json'])
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'workflow-step-contract-validator')
  assert.equal(result.stdout.endsWith('}\n'), true)
  assert.equal(result.stderr, '', 'a passing run wrote diagnostics nobody asked for')
})

test('an incomplete run says so on stderr and exits 2', async (t) => {
  const directory = await temporary(t, 'workflow-contract-cli-')
  const specPath = join(directory, 'empty.json')
  await writeFile(specPath, JSON.stringify({ schemaVersion: '1', steps: [] }), 'utf8')

  const result = await runCli(['--spec', specPath, '--json'])
  assert.equal(result.code, 2)
  assert.equal(JSON.parse(result.stdout).status, 'incomplete')
  assert.match(result.stderr, /incomplete: 0 of 0 declared step\(s\) were analysed/)
})

test('the execution contract is written where it was asked for', async (t) => {
  const directory = await temporary(t, 'workflow-contract-cli-out-')
  const destination = join(directory, 'nested', 'execution-contract.json')

  const result = await runCli(['--spec', clean, '--contract', destination])
  assert.equal(result.code, 0)
  assert.match(result.stderr, /contract written: 5 step\(s\), 5 ordered, complete=true/)
  const written = await readFile(destination, 'utf8')
  assert.equal(written.endsWith('\n'), true)
  const contract = JSON.parse(written)
  assert.equal(contract.complete, true)
  assert.deepEqual(contract.order[0], { stage: 0, steps: ['fetch-order'] })
})

test('every documented limit is wired to a flag that changes the outcome', async (t) => {
  const directory = await temporary(t, 'workflow-contract-cli-limits-')
  const specPath = join(directory, 'spec.json')
  await writeFile(specPath, JSON.stringify({
    schemaVersion: '1',
    provided: [{ name: 's1', type: 'string' }, { name: 's2', type: 'string' }],
    exports: [{ name: 'x', type: 'string' }, { name: 'y', type: 'string' }],
    steps: [
      { id: 'a', version: '1.0.0', inputs: [{ name: 's1', type: 'string' }], outputs: [{ name: 'x', type: 'string' }] },
      { id: 'b', version: '1.0.0', requires: ['a', 'c'], inputs: [{ name: 's2', type: 'string' }], outputs: [{ name: 'y', type: 'string' }] },
      { id: 'c', version: '1.0.0' },
    ],
  }), 'utf8')

  const expectations = [
    [['--max-bytes', '10'], 'spec-too-large'],
    [['--max-steps', '1'], 'too-many-steps'],
    [['--max-provided', '1'], 'too-many-provided'],
    [['--max-exports', '1'], 'too-many-exports'],
    [['--max-ports-per-step', '1'], 'too-many-ports'],
    [['--max-dependencies-per-step', '1'], 'too-many-dependencies'],
    [['--max-depth', '1'], 'graph-too-deep'],
    [['--max-graph-operations', '1'], 'graph-budget-exceeded'],
    // A budget of zero milliseconds is spent before any work is done, which is
    // what proves this entry point wires a clock through at all. A documented
    // limit the CLI never wires is a limit that is not enforced.
    [['--max-millis', '0'], 'time-budget-exceeded'],
  ]
  for (const [flags, ruleId] of expectations) {
    const result = await runCli(['--spec', specPath, '--json', ...flags])
    assert.equal(result.code, 2, `${flags.join(' ')} did not make the run incomplete`)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.ok(
      report.findings.some((finding) => finding.ruleId === ruleId),
      `${flags.join(' ')} did not raise ${ruleId}`,
    )
  }

  // With every limit left alone the same specification is clean, so each
  // failure above is the limit talking and not the fixture.
  const baseline = await runCli(['--spec', specPath, '--json'])
  assert.equal(baseline.code, 0)
  assert.deepEqual(JSON.parse(baseline.stdout).findings, [])
})

test('a specification that is not UTF-8 is reported rather than decoded loosely', async (t) => {
  const directory = await temporary(t, 'workflow-contract-cli-bytes-')
  const specPath = join(directory, 'spec.json')
  await writeFile(specPath, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]))

  const result = await runCli(['--spec', specPath, '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['spec-not-utf8'])
  assert.equal(report.status, 'incomplete')
})
