import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parseFailureDetail } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')

/**
 * A specification that does not parse must not be quoted back.
 *
 * `spec-not-json` carried `String(error.message)` as its evidence, and V8 has
 * two failure messages -- one of which embeds the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. So a
 * specification file short enough to be only a credential was reproduced in
 * full on stdout, in the JSON report, by the finding whose whole purpose is to
 * say that nothing was read.
 *
 * `sanitize` would not have helped: it replaces control characters and cuts
 * from the end, and the quoted span sits at the *front* of the message.
 *
 * `AKIAIOSFODNN7EXAMPLE` is the AWS documentation placeholder, not a key.
 */
const CANARY = 'AKIAIOSFODNN7EXAMPLE'

// Longer than V8's ten-character window, so a leak is a prefix rather than the
// whole string. Truncating the message would not have caught this one.
const LONG_SECRET = 'password=hunter2-correct-horse-battery-staple'

const MIN_RUN = 8

/**
 * Assert that no run of `secret` eight characters or longer survives.
 *
 * Every run, not only every prefix: V8 quotes a window around the offending
 * character, so a secret in the middle of a document leaks from its middle.
 * Asserting only on the whole string would pass against a report that carried
 * `AKIAIOSF` and called that truncation.
 */
function assertNoLeak(secret, ...streams) {
  const haystack = streams.join('\n')
  for (let length = secret.length; length >= MIN_RUN; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const window = secret.slice(start, start + length)
      assert.equal(haystack.includes(window), false, `output echoed ${JSON.stringify(window)}`)
    }
  }
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

/** Write `text` as a specification in a throwaway directory and run the real CLI. */
async function runSpec(t, text, extraArgs = []) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-step-contract-validator-parse-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = join(directory, 'spec.json')
  await writeFile(spec, text)
  return runCli(['--spec', spec, ...extraArgs])
}

test('a specification that is only a credential is not quoted back into the JSON report', async (t) => {
  const { stdout, stderr } = await runSpec(t, CANARY, ['--json'])
  const report = JSON.parse(stdout)
  assert.equal(report.findings[0].ruleId, 'spec-not-json')
  assertNoLeak(CANARY, stdout, stderr)
})

test('the human summary never carried the evidence field, and still does not', async (t) => {
  // The leak was in the JSON report: `formatReport` prints no evidence, so the
  // human summary was already clean. Pinned here so a later edit that starts
  // printing evidence has to face this assertion.
  const { stdout, stderr } = await runSpec(t, CANARY)
  assert.match(stdout, /spec-not-json/)
  assertNoLeak(CANARY, stdout, stderr)
})

test("a secret longer than V8's quoting window does not leak its prefix either", async (t) => {
  const { stdout, stderr } = await runSpec(t, LONG_SECRET, ['--json'])
  assertNoLeak(LONG_SECRET, stdout, stderr)
  assert.equal(stdout.includes('password=h'), false)
})

test('a secret sitting mid-document does not leak through the windowed form', async (t) => {
  // V8 answers this one with `Unexpected token '}', "[ }AKIAIOSFO"...`: the
  // shape that quotes a window rather than a leading prefix.
  const { stdout, stderr } = await runSpec(t, `[ }${CANARY}]`, ['--json'])
  assertNoLeak(CANARY, stdout, stderr)
})

test('the position, line and column of a parse failure survive the fix', async (t) => {
  const { stdout } = await runSpec(t, '{"schemaVersion": "1" "steps": []}', ['--json'])
  const [finding] = JSON.parse(stdout).findings
  assert.equal(finding.ruleId, 'spec-not-json')
  assert.match(finding.evidence, /at position 22 \(line 1 column 23\)/)
})

test('the evidence still names the token: evidence that says nothing is its own defect', async (t) => {
  const { stdout } = await runSpec(t, CANARY, ['--json'])
  const [finding] = JSON.parse(stdout).findings
  assert.match(finding.evidence, /unexpected token 'A'/)
})

test('parseFailureDetail keeps the position and drops the quoted window', () => {
  const detail = (text) => {
    try {
      JSON.parse(text)
      throw new Error('that text parsed')
    } catch (error) {
      return parseFailureDetail(error)
    }
  }

  // The positional form is all position and no input, and is kept whole.
  assert.equal(
    detail('{"schemaVersion": "1" "steps": []}'),
    "Expected ',' or '}' after property value in JSON at position 22 (line 1 column 23)",
  )
  assert.equal(detail('{"a":1}x'), 'Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)')
  assert.equal(detail(''), 'Unexpected end of JSON input')
  assert.equal(detail('[1,2,'), 'Unexpected end of JSON input')

  // Every quoted shape: the whole input, a leading prefix, and a window.
  assert.equal(detail(CANARY), "unexpected token 'A' near the start")
  assert.equal(detail(LONG_SECRET), "unexpected token 'p' near the start")
  assert.equal(detail(`[ }${CANARY}]`), "unexpected token '}' near the start")
  assert.equal(detail(`{"aaaaaaaaaaaaaa": [ }${CANARY} ]}`), "unexpected token '}'")
})

test('parseFailureDetail refuses a specification whose own bytes imitate a position', () => {
  // The quoted form is matched first for exactly this reason.
  let detail
  try {
    JSON.parse(`at position 12 ${CANARY}`)
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assertNoLeak(CANARY, detail)
  assert.equal(detail.includes('at position 12'), false)
})

test('parseFailureDetail sanitises a control character that arrives as the token', () => {
  // V8 names the offending character, and that character came from the
  // specification, so it goes through the same guard as every other value.
  let detail
  try {
    JSON.parse(String.fromCharCode(0x1b))
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail.includes(String.fromCharCode(0x1b)), false)
})

test('parseFailureDetail says something for an error it does not recognise', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('something else entirely')), 'it could not be parsed as JSON')
})
