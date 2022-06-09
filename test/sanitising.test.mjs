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
