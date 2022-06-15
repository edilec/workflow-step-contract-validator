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
 *
 * A helper asserted in isolation -- `byCodeUnit('Z', 'a') < 0` -- pins the
 * helper and nothing else, because every call site can still be swapped one at a
 * time. So there is a case here for each site that orders something reaching
 * output, each one built from values whose collated order differs from their
 * code-unit order and driven through the real entry point:
 *
 * | site | what it orders | case below |
 * | --- | --- | --- |
 * | `resolveExecutionOrder` node ids | the first stage, and which cycle is rooted first | stage 0 |
 * | `resolveExecutionOrder` successors | which cycle a branching graph names | the branching cycle |
 * | `resolveExecutionOrder` next stage | later stages | later stages |
 * | `rotate` | where a cycle is written from | the two-step cycle |
 * | `compareFindingRows` pointer | the finding order | the pointer order |
 * | `compareFindingRows` message | two findings alike but for their message | the two unknown keys |
 * | `buildProducers` owner | which producer a channel binds to | the shadowed channel |
 * | `describeChannels` consumers | the consumer list | the consumers |
 * | `describeChannels` name | the channel list | the contract listings |
 * | `normalizeSpec` step ids | the step list | the contract listings |
 *
 * The one comparison left out is `compareFindingRows` on `ruleId`. Rule ids are
 * drawn from a closed set of 36 values over `[a-z-]`, and every one of the 1296
 * ordered pairs collates exactly as its code units do, so no document can make
 * that call site observable. It is an equivalent mutant, not a gap.
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

test('a cycle is written from its code-unit-smallest member, not its collated-smallest', () => {
  // 'Z' (0x5A) before 'apple' (0x61) by code unit; a collator folds case and
  // puts 'apple' first, which moves both the pointer and the message.
  const { report } = run({
    schemaVersion: '1',
    steps: [
      { id: 'Z', version: '1.0.0', requires: ['apple'] },
      { id: 'apple', version: '1.0.0', requires: ['Z'] },
    ],
  })
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), ['/steps/Z'])
  assert.equal(
    report.findings[0].message.startsWith('Steps form a dependency cycle: Z -> apple -> Z,'),
    true,
    `written as: ${report.findings[0].message}`,
  )
})

test('which cycle a branching graph names does not depend on collation', () => {
  // 'A' waits for two steps that are both in a cycle. Successors are visited in
  // code-unit order, so 'Zed' is entered first and the cycle found runs through
  // all three. A collator enters 'apple' first, finds the short cycle
  // A -> apple -> A, and then calls 'Zed' merely unschedulable: a different
  // verdict, a different finding count, about the same graph.
  const { report } = run({
    schemaVersion: '1',
    steps: [
      { id: 'A', version: '1.0.0', requires: ['Zed', 'apple'] },
      { id: 'Zed', version: '1.0.0', requires: ['apple'] },
      { id: 'apple', version: '1.0.0', requires: ['A'] },
    ],
  })
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.pointer]),
    [['dependency-cycle', '/steps/A']],
  )
  assert.equal(report.summary.errors, 1)
  assert.equal(
    report.findings[0].message.startsWith('Steps form a dependency cycle: A -> Zed -> apple -> A,'),
    true,
    `written as: ${report.findings[0].message}`,
  )
})

test('two findings alike but for their message are ordered by code unit', () => {
  // Both sit at pointer '/' under the same rule id, so the message is the only
  // key left. The document declares 'apple' first, so declaration order -- the
  // final tiebreak -- would give the other answer, and so would a collator.
  const { report } = run({ schemaVersion: '1', apple: true, Zebra: true, steps: [{ id: 's', version: '1.0.0' }] })
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), ['/', '/'])
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['unknown-declaration-key', 'unknown-declaration-key'],
  )
  assert.deepEqual(report.findings.map((finding) => finding.message), [
    'The specification declares an unknown top-level key "Zebra"; its intent could not be read.',
    'The specification declares an unknown top-level key "apple"; its intent could not be read.',
  ])
})

test('the producer a channel binds to is its code-unit-first owner', () => {
  // Two steps produce 'x'. The code-unit-first owner is the one the consumer is
  // checked against and the one the contract names; the other is the duplicate.
  // A collator swaps the two, which moves the finding, the message, the channel
  // and the binding recorded for the consumer.
  const { report, contract } = run({
    schemaVersion: '1',
    steps: [
      { id: 'Z', version: '1.0.0', outputs: [{ name: 'x', type: 'string' }] },
      { id: 'apple', version: '1.0.0', outputs: [{ name: 'x', type: 'string' }] },
      { id: 'c', version: '1.0.0', inputs: [{ name: 'x', type: 'string' }] },
    ],
  })
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.pointer]),
    [['duplicate-producer', '/steps/apple/outputs/x']],
  )
  assert.equal(
    report.findings[0].message,
    'Channel "x" is produced by apple and by Z, so which value a consumer receives is undefined.',
  )
  assert.equal(contract.channels[0].producer, 'Z')
  assert.deepEqual(contract.steps.find((step) => step.id === 'c').consumes, [
    { name: 'x', type: 'string', optional: false, minVersion: null, from: 'Z', resolved: true },
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
