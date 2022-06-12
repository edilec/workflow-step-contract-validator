import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { resolveContractDestination, writeContractFile } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')

/**
 * The execution contract is a derived artifact, and the specification is
 * read-only. The guarantee is that a contract can never be written over the
 * document it was derived from -- and, just as importantly, that a legitimate
 * destination is not refused. A false refusal is a defect of its own: on a
 * host where the destination sits under a symlinked directory, a check that
 * compared a resolved path against an unresolved one would refuse every write.
 *
 * A hard link is the case a path comparison cannot see. A symbolic link has a
 * target and `realpath` collapses it; a hard link has none, so two names for one
 * inode resolve to two different real paths, a path comparison calls them
 * different files, and the write destroys the specification. That is why the
 * guard compares device and inode, and why the case below asserts the bytes of
 * the specification afterwards rather than only the exit code.
 */

const SPEC = JSON.stringify({ schemaVersion: '1', steps: [{ id: 'a', version: '1.0.0' }] })

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-confine-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const specPath = join(directory, 'spec.json')
  await writeFile(specPath, SPEC, 'utf8')
  return { directory, specPath }
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

test('a destination that resolves to the specification is refused', async (t) => {
  const { directory, specPath } = await workspace(t)
  await assert.rejects(
    () => resolveContractDestination(specPath, specPath),
    /is the specification itself/,
  )
  // Spelled as a different path, through a symbolic link, and naming the same
  // file. Comparing the two strings would accept this and destroy the input.
  const alias = join(directory, 'alias.json')
  await symlink(specPath, alias)
  await assert.rejects(
    () => resolveContractDestination(specPath, alias),
    /is the specification itself/,
  )
})

test('a hard link to the specification is refused, and the specification survives', async (t) => {
  const { directory, specPath } = await workspace(t)
  const hard = join(directory, 'hard.json')
  await link(specPath, hard)

  // The premise: one file, two names, two different real paths. A guard that
  // compared resolved paths would accept this destination.
  const [specStat, hardStat] = await Promise.all([stat(specPath), stat(hard)])
  assert.equal(hardStat.ino, specStat.ino, 'the fixture did not create a hard link')
  assert.equal(hardStat.dev, specStat.dev, 'the fixture did not create a hard link')
  assert.notEqual(await realpath(hard), await realpath(specPath), 'a hard link is supposed to resolve elsewhere')

  await assert.rejects(() => resolveContractDestination(specPath, hard), /is the specification itself/)

  const result = await runCli(['--spec', specPath, '--contract', hard])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a configuration error wrote a report')
  assert.match(result.stderr, /--contract is not usable/)
  assert.equal(await readFile(specPath, 'utf8'), SPEC, 'the specification was overwritten through a hard link')
  assert.equal(await readFile(hard, 'utf8'), SPEC, 'the specification was overwritten through a hard link')
})

test('a hard link to something that is not the specification is still a legitimate destination', async (t) => {
  const { directory, specPath } = await workspace(t)
  const other = join(directory, 'other.json')
  await writeFile(other, '{}', 'utf8')
  const hardToOther = join(directory, 'hard-other.json')
  await link(other, hardToOther)

  const resolved = await resolveContractDestination(specPath, hardToOther)
  await writeContractFile(resolved, { ok: true })
  assert.equal(JSON.parse(await readFile(other, 'utf8')).ok, true)
  assert.equal(await readFile(specPath, 'utf8'), SPEC)
})

test('a legitimate destination is accepted, including under a symlinked directory', async (t) => {
  const { directory, specPath } = await workspace(t)
  const real = join(directory, 'real-output')
  await mkdir(real)
  const linked = join(directory, 'linked-output')
  await symlink(real, linked)

  const resolved = await resolveContractDestination(specPath, join(linked, 'contract.json'))
  assert.equal(resolved.endsWith(join('real-output', 'contract.json')), true)

  // The destination does not exist yet, and neither does its parent: the
  // nearest existing ancestor is resolved and the rest is appended.
  const deep = await resolveContractDestination(specPath, join(linked, 'a', 'b', 'contract.json'))
  assert.equal(deep.endsWith(join('real-output', 'a', 'b', 'contract.json')), true)

  await writeContractFile(resolved, { ok: true })
  assert.equal(JSON.parse(await readFile(join(real, 'contract.json'), 'utf8')).ok, true)
})

test('a destination that is not a path at all is refused', async (t) => {
  const { specPath } = await workspace(t)
  for (const value of ['', '   ', null, 7]) {
    await assert.rejects(() => resolveContractDestination(specPath, value), /must be a non-empty path/)
  }
})

test('a specification that cannot be resolved is refused before anything is written', async (t) => {
  const { directory } = await workspace(t)
  await assert.rejects(
    () => resolveContractDestination(join(directory, 'gone.json'), join(directory, 'contract.json')),
    /The specification could not be resolved: ENOENT/,
  )
})

test('the real CLI refuses to write the contract over its own input', async (t) => {
  const { directory, specPath } = await workspace(t)
  const alias = join(directory, 'alias.json')
  await symlink(specPath, alias)

  for (const destination of [specPath, alias]) {
    const result = await runCli(['--spec', specPath, '--contract', destination])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error wrote a report')
    assert.match(result.stderr, /--contract is not usable/)
    assert.equal(await readFile(specPath, 'utf8'), SPEC, 'the specification was overwritten')
  }
})
