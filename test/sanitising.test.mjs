import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { analyzeWorkflow, formatReport } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')

/**
 * Sanitising, pinned on what a run emits rather than on the regular expression
 * that does it.
 *
 * Every class in the contract's table is pushed through the tool in an
 * *identifier* position -- a step id, a declaration key, a type name, a
 * version string, the workflow label, the source label -- and the assertion is
 * that no code point from the table appears anywhere in stdout, in either
 * output mode. A tool that sanitised its evidence field carefully and left an
 * id alone would pass a regular-expression test and fail this one.
 */

const CH = (code) => String.fromCharCode(code)

const FORBIDDEN = [
  ['C0 BEL U+0007', 0x07],
  ['C0 LF U+000A', 0x0a],
  ['C0 ESC U+001B', 0x1b],
  ['DEL U+007F', 0x7f],
  ['C1 NEL U+0085', 0x85],
  ['C1 CSI U+009B', 0x9b],
  ['line separator U+2028', 0x2028],
  ['paragraph separator U+2029', 0x2029],
  ['LRM U+200E', 0x200e],
  ['RLM U+200F', 0x200f],
  ['LRE U+202A', 0x202a],
  ['RLO U+202E', 0x202e],
  ['isolate U+2066', 0x2066],
  ['pop isolate U+2069', 0x2069],
]

/** A specification that carries the character in six identifier positions. */
function hostileSpec(code) {
  const poison = CH(code)
  return {
    schemaVersion: '1',
    workflow: `demo${poison}workflow`,
    [`unknown${poison}key`]: true,
    provided: [{ name: 'seed', type: `Se${poison}ed` }],
    steps: [
      { id: `bad${poison}id`, version: '1.0.0' },
      { id: 'ok', version: `1.0${poison}.0`, inputs: [{ name: 'seed', type: 'string' }] },
    ],
  }
}

function run(spec, source) {
  return analyzeWorkflow({ bytes: new TextEncoder().encode(JSON.stringify(spec)), source })
}

/**
 * Every string value in a report or a contract, however deeply nested.
 *
 * The check is on the values rather than on the serialised text, because
 * `JSON.stringify` escapes a newline into two harmless characters. A consumer
 * that parses the report gets the newline back.
 */
function stringsIn(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, found)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsIn(item, found)
  return found
}

test('no forbidden code point reaches any value in the report or the contract', () => {
  for (const [name, code] of FORBIDDEN) {
    const source = `spec${CH(code)}.json`
    const { report, contract } = run(hostileSpec(code), source)
    for (const value of stringsIn({ report, contract })) {
      assert.equal(
        value.includes(CH(code)),
        false,
        `${name} reached the output through an identifier, a key, a type, a version, the workflow name or the source label`,
      )
    }
    // The run still says what it found: sanitising is not swallowing.
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.length >= 3, `${name} lost the findings it was supposed to carry`)
  }
})

test('no forbidden code point reaches a line of the human report', () => {
  for (const [name, code] of FORBIDDEN) {
    const { report, contract } = run(hostileSpec(code), `spec${CH(code)}.json`)
    const lines = formatReport(report, contract).trimEnd().split('\n')
    assert.equal(lines.length, 3 + report.findings.length, `${name} changed how many lines the report has`)
    for (const line of lines) {
      assert.equal(line.includes(CH(code)), false, `${name} reached a line of the human report`)
    }
  }
})

test('an identifier cannot forge a line in the human report', () => {
  const { report, contract } = run(hostileSpec(0x0a), 'spec.json')
  const lines = formatReport(report, contract).trimEnd().split('\n')
  // Two summary lines, one order line, and one line per finding. A newline
  // that survived inside an id would add a line that looks like a finding.
  assert.equal(lines.length, 3 + report.findings.length)
  for (const line of lines.slice(3)) {
    assert.match(line, /^(ERROR|WARNING|INFO) {1,4}/)
  }
})

/**
 * The bounds, pinned on what a run emits.
 *
 * Removing a class of control character is only half of sanitising. The other
 * half is the length bound, and it is load-bearing for exactly the fields whose
 * content the document controls without limit:
 *
 * - a `dependency-cycle` message interpolates every member of the cycle, so it
 *   grows with the workflow (up to `maxSteps` ids of up to 100 characters);
 * - `evidence` echoes the raw string that was rejected, and a string is only
 *   rejected *because* it was not a valid, length-checked identifier;
 * - the workflow label and the source label are free text.
 *
 * Each assertion below is the emitted length, so dropping the limit at the one
 * construction site turns it red.
 */

const CYCLE_ID_LENGTH = 80
const CYCLE_MEMBERS = 20
const cycleIds = Array.from(
  { length: CYCLE_MEMBERS },
  (_, index) => `c${String(index).padStart(2, '0')}${'x'.repeat(CYCLE_ID_LENGTH - 3)}`,
)

test('a message grown by the document is bounded and says it was cut', () => {
  const { report } = run({
    schemaVersion: '1',
    steps: cycleIds.map((id, index) => ({
      id,
      version: '1.0.0',
      requires: [cycleIds[(index + 1) % cycleIds.length]],
    })),
  }, 'spec.json')
  const cycle = report.findings.find((finding) => finding.ruleId === 'dependency-cycle')
  assert.equal(cycleIds[0].length, CYCLE_ID_LENGTH, 'the fixture ids are not the length it claims')
  // 20 ids of 80 characters plus the prose is thousands of characters long.
  assert.equal(cycle.message.length, 403, 'the message bound stopped being applied')
  assert.equal(cycle.message.endsWith('...'), true, 'a cut message did not say it was cut')
  assert.equal(cycle.message.startsWith(`Steps form a dependency cycle: ${cycleIds[0]} -> `), true)
  // The suggestion beside it is a fixed string and is nowhere near the bound,
  // so this is the message being cut and not the whole finding.
  assert.equal(cycle.suggestion, 'Break the cycle by removing a dependency or by splitting a step.')
})

test('evidence echoing a rejected string is bounded and says it was cut', () => {
  const rejected = `9${'e'.repeat(500)}`
  const { report } = run({
    schemaVersion: '1',
    steps: [{ id: 'a', version: '1.0.0', outputs: [{ name: rejected, type: 'string' }] }],
  }, 'spec.json')
  const finding = report.findings.find((entry) => entry.ruleId === 'port-name-invalid')
  assert.equal(finding.evidence.length, 203, 'the evidence bound stopped being applied')
  assert.equal(finding.evidence.endsWith('...'), true)
  assert.equal(finding.evidence.startsWith('9eee'), true)
})

test('a label the document chose is bounded in the report and in the contract', () => {
  const { report, contract } = run({
    schemaVersion: '1',
    workflow: 'w'.repeat(500),
    steps: [{ id: 'a', version: '1.0.0', outputs: [{ name: 'spare', type: 'string' }] }],
  }, `${'s'.repeat(500)}.json`)
  assert.equal(contract.workflow.length, 123, 'the workflow label bound stopped being applied')
  assert.equal(contract.workflow.endsWith('...'), true)
  assert.equal(contract.source.length, 123, 'the source label bound stopped being applied')
  assert.equal(report.findings[0].ruleId, 'output-unconsumed', 'the fixture raised nothing to carry a label')
  assert.equal(report.findings[0].location.file.length, 123)
})

test('an identifier that would need escaping in a pointer is refused instead', () => {
  // Every pointer this tool emits is an identifier interpolated straight into a
  // path, and that is safe for one reason: `/` and `~`, the two characters RFC
  // 6901 escapes, are not in the identifier grammar. So an id that would have
  // needed escaping is refused and reported at an index-based pointer, and no
  // pointer ever carries an escape to get wrong.
  const { report } = run({
    schemaVersion: '1',
    steps: [
      { id: 'a/b', version: '1.0.0' },
      { id: 'c~d', version: '1.0.0' },
      {
        id: 'ok',
        version: '1.0.0',
        requires: ['p/q'],
        outputs: [{ name: 'x/y', type: 'string' }, { name: 'z~w', type: 'string' }],
      },
    ],
  }, 'spec.json')
  assert.deepEqual(report.findings.map((finding) => [finding.ruleId, finding.location.pointer]), [
    ['step-id-invalid', '/steps/0'],
    ['step-id-invalid', '/steps/1'],
    ['port-name-invalid', '/steps/ok/outputs/0'],
    ['port-name-invalid', '/steps/ok/outputs/1'],
    ['dependency-malformed', '/steps/ok/requires/0'],
  ])
  assert.equal(report.status, 'incomplete')
  // The rejected spelling is still named, in the one field that quotes it.
  assert.deepEqual(report.findings.map((finding) => finding.evidence), ['a/b', 'c~d', 'x/y', 'z~w', 'p/q'])
  for (const finding of report.findings) {
    assert.match(
      finding.location.pointer,
      /^\/[^~]*$/,
      `pointer ${finding.location.pointer} carries a character RFC 6901 would have to escape`,
    )
  }
})

test('no forbidden code point reaches the real CLI on stdout, in either output mode', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-sanitise-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  for (const [name, code] of FORBIDDEN) {
    const specPath = join(directory, 'spec.json')
    await writeFile(specPath, JSON.stringify(hostileSpec(code)), 'utf8')
    for (const extra of [[], ['--json']]) {
      const result = await execFileAsync(process.execPath, [cli, '--spec', specPath, ...extra], { cwd: projectDirectory })
        .then((value) => value, (error) => error)
      assert.equal(result.code, 2, `${name}: the hostile specification should be incomplete`)
      for (const line of result.stdout.split('\n')) {
        assert.equal(line.includes(CH(code)), false, `${name} reached stdout of the real CLI`)
      }
      if (extra.length === 1) {
        for (const value of stringsIn(JSON.parse(result.stdout))) {
          assert.equal(value.includes(CH(code)), false, `${name} reached a parsed value of the real CLI report`)
        }
      }
    }
  }
})

test('the evidence still names what was rejected, with the character removed', () => {
  const { report } = run(hostileSpec(0x9b), 'spec.json')
  const badId = report.findings.find((finding) => finding.ruleId === 'step-id-invalid')
  assert.equal(badId.evidence, 'bad id')
  const badVersion = report.findings.find((finding) => finding.ruleId === 'step-version-invalid')
  assert.equal(badVersion.evidence, '1.0 .0')
  const unknownKey = report.findings.find((finding) => finding.ruleId === 'unknown-declaration-key')
  assert.match(unknownKey.message, /top-level key "unknown key"/)
})
