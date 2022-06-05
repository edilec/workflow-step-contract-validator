import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { analyzeWorkflow } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')
const clean = join(projectDirectory, 'examples', 'order-fulfilment.json')

const run = (spec) => analyzeWorkflow({ bytes: new TextEncoder().encode(spec), source: 'spec.json' })

test('two runs over the same specification produce byte-identical stdout', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-determinism-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const first = await execFileAsync(process.execPath, [cli, '--spec', clean, '--contract', join(directory, 'one.json'), '--json'], { cwd: projectDirectory })
  const second = await execFileAsync(process.execPath, [cli, '--spec', clean, '--contract', join(directory, 'two.json'), '--json'], { cwd: projectDirectory })
  assert.equal(first.stdout, second.stdout)
  assert.equal(await readFile(join(directory, 'one.json'), 'utf8'), await readFile(join(directory, 'two.json'), 'utf8'))
  // Nothing in the output is a clock reading, so nothing in it moves between
  // runs: no timestamp, no duration, no run id.
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(first.stdout), false, 'the report carries a timestamp')
})

test('declaration order and object key order do not reach the output', () => {
  const declared = JSON.stringify({
    schemaVersion: '1',
    workflow: 'shuffled',
    provided: [{ name: 'seed', type: 'string' }],
    exports: [{ name: 'out', type: 'string' }],
    steps: [
      { id: 'first', version: '1.0.0', inputs: [{ name: 'seed', type: 'string' }], outputs: [{ name: 'middle', type: 'string' }] },
      { id: 'second', version: '1.0.0', inputs: [{ name: 'middle', type: 'string' }], outputs: [{ name: 'out', type: 'string' }] },
    ],
  })
  const shuffled = JSON.stringify({
    workflow: 'shuffled',
    steps: [
      { outputs: [{ type: 'string', name: 'out' }], version: '1.0.0', inputs: [{ type: 'string', name: 'middle' }], id: 'second' },
      { inputs: [{ type: 'string', name: 'seed' }], outputs: [{ type: 'string', name: 'middle' }], id: 'first', version: '1.0.0' },
    ],
    exports: [{ type: 'string', name: 'out' }],
    provided: [{ type: 'string', name: 'seed' }],
    schemaVersion: '1',
  })
  assert.notEqual(declared, shuffled, 'the two documents are supposed to differ byte for byte')
  assert.deepEqual(run(shuffled), run(declared))
  assert.deepEqual(run(declared).contract.order, [{ stage: 0, steps: ['first'] }, { stage: 1, steps: ['second'] }])
})

test('the same specification read from two different paths differs only in its label', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-determinism-path-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const document = JSON.stringify({ schemaVersion: '1', steps: [{ id: 'a', version: '1.0.0', inputs: [{ name: 'x', type: 'string' }] }] })
  const one = join(directory, 'one.json')
  const two = join(directory, 'nested-two.json')
  await writeFile(one, document, 'utf8')
  await writeFile(two, document, 'utf8')

  const runs = await Promise.all([one, two].map((path) => execFileAsync(process.execPath, [cli, '--spec', path, '--json'], { cwd: projectDirectory })
    .then((result) => result, (error) => error)))
  const reports = runs.map((result) => JSON.parse(result.stdout))
  // Both labels are base names: the specification is outside the working
  // directory, and an absolute host path never reaches a report.
  assert.deepEqual(reports.map((report) => report.findings[0].location.file), ['one.json', 'nested-two.json'])
  for (const report of reports) {
    assert.equal(JSON.stringify(report).includes(directory), false)
  }
  assert.deepEqual(
    { ...reports[0], findings: reports[0].findings.map((finding) => ({ ...finding, location: null })) },
    { ...reports[1], findings: reports[1].findings.map((finding) => ({ ...finding, location: null })) },
  )
})
