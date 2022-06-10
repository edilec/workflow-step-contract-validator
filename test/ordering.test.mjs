import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { analyzeWorkflow } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')

/**
 * Ordering, pinned by what the tool emits rather than by how it is spelled.
 *
 * Grepping the source for `.localeCompare(` is not a determinism test: an
 * `Intl.Collator` drops the forbidden literal and collates exactly as badly,
 * so the grep stays green while the resolved order starts depending on the ICU
 * data of whichever host ran it. Every identifier below is chosen so that
 * code-unit order and collation order genuinely disagree:
 *
 * - a collator folds case, so it puts `assets` before `README` and `Z`;
 * - a collator treats `-` and `_` as ignorable punctuation, so it cannot tell
 *   `a-b` from `a_b` by that character and orders them by what follows.
 *
 * Code units give exactly one answer: R(0x52) Z(0x5A) a(0x61), then `a` before
 * `a-b` because it is a prefix, then `-`(0x2D) before `_`(0x5F) before `s`.
 * Substitute a collator anywhere in this tool and these assertions go red.
 */

const CODE_UNIT_ORDER = ['README', 'Z', 'a', 'a-b', 'a_b', 'assets']
// Declaration order is deliberately the reverse of the answer.
const DECLARED = [...CODE_UNIT_ORDER].reverse()

/**
 * The findings are ordered by the whole field path, and a path continues past
 * the step id, so `/steps/a-b/...` precedes `/steps/a/...`: at the ninth
 * character the comparison is `-` (0x2D) against `/` (0x2F). That is a third
 * answer, different from both the collated order and the order of the ids
 * alone, which makes it worth pinning literally.
 */
const POINTER_ORDER = [
  '/steps/README/outputs/README',
  '/steps/Z/outputs/Z',
  '/steps/a-b/outputs/a-b',
  '/steps/a/outputs/a',
  '/steps/a_b/outputs/a_b',
  '/steps/assets/outputs/assets',
]

const spec = {
  schemaVersion: '1',
  workflow: 'ordering',
  steps: DECLARED.map((id) => ({ id, version: '1.0.0', outputs: [{ name: id, type: 'string' }] })),
}

function run(document = spec) {
  return analyzeWorkflow({ bytes: new TextEncoder().encode(JSON.stringify(document)), source: 'ordering.json' })
}

test('findings reach the report in code-unit order of their field path', () => {
  const { report } = run()
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), POINTER_ORDER)
})

test('a stage lists its steps in code-unit order, and so do the contract listings', () => {
  const { contract } = run()
  assert.deepEqual(contract.order, [{ stage: 0, steps: CODE_UNIT_ORDER }])
  assert.deepEqual(contract.steps.map((step) => step.id), CODE_UNIT_ORDER)
  assert.deepEqual(contract.channels.map((channel) => channel.name), CODE_UNIT_ORDER)
})

test('the consumers of a channel are listed in code-unit order', () => {
  const { contract } = run({
    schemaVersion: '1',
    provided: [{ name: 'seed', type: 'string' }],
    steps: DECLARED.map((id) => ({ id, version: '1.0.0', inputs: [{ name: 'seed', type: 'string' }] })),
  })
  assert.deepEqual(contract.channels[0].consumers, CODE_UNIT_ORDER)
})

test('later stages are ordered within themselves, not merged into one list', () => {
  const { contract } = run({
    schemaVersion: '1',
    steps: [
      { id: 'assets', version: '1.0.0', requires: ['Z'] },
      { id: 'README', version: '1.0.0', requires: ['Z'] },
      { id: 'Z', version: '1.0.0' },
      { id: 'a-b', version: '1.0.0', requires: ['Z'] },
    ],
  })
  assert.deepEqual(contract.order, [
    { stage: 0, steps: ['Z'] },
    { stage: 1, steps: ['README', 'a-b', 'assets'] },
  ])
})

test('the real CLI emits the same order over a file on disk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-order-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const specPath = join(directory, 'ordering.json')
  const contractPath = join(directory, 'contract.json')
  await writeFile(specPath, JSON.stringify(spec), 'utf8')

  const result = await execFileAsync(
    process.execPath,
    [cli, '--spec', specPath, '--contract', contractPath, '--json'],
    { cwd: projectDirectory },
  )
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), POINTER_ORDER)
  const written = JSON.parse(await (await import('node:fs/promises')).readFile(contractPath, 'utf8'))
  assert.deepEqual(written.order, [{ stage: 0, steps: CODE_UNIT_ORDER }])
})
