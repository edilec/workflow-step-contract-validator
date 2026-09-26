import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { assertWritableDestination } from '../src/index.mjs'

/**
 * The write guard, one case per hole.
 *
 * Every one of these was reproduced against this tool before the guard existed:
 * `--contract` pointing at a symbolic link destroyed the file the link pointed
 * at, the tool exited 0 and its stderr said "contract written". Knowing about a
 * hole does not close it -- a test that fails when the guard is removed does --
 * so each case below asserts the exit code, the empty stdout, and the bytes of
 * the file that was supposed to be destroyed.
 *
 * The allowed cases carry the same weight. A guard that refuses everything
 * passes a data-loss test while making the tool useless, so a plain new file
 * and a file in a real subdirectory are asserted to be written.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'workflow-step-contract-validator.mjs')

const SPEC = JSON.stringify({
  schemaVersion: '1',
  steps: [
    { id: 'collect', version: '1.0.0', outputs: [{ name: 'order', type: 'Order' }] },
    { id: 'charge', version: '1.0.0', inputs: [{ name: 'order', type: 'Order' }] },
  ],
})
const BYSTANDER = 'a file this tool was never asked to touch\n'

/**
 * A workspace shaped like the reproduction: a root the caller writes into and
 * a directory outside it that the guard must keep out of reach.
 */
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-guard-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'root')
  const outside = join(directory, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const spec = join(root, 'workflow.json')
  await writeFile(spec, SPEC, 'utf8')
  const bystander = join(outside, 'precious.txt')
  await writeFile(bystander, BYSTANDER, 'utf8')
  return { directory, root, outside, spec, bystander }
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

async function exists(path) {
  return access(path).then(() => true, () => false)
}

test('hole 1: a symbolic link at the destination is refused and the file it points at survives', async (t) => {
  const { root, bystander } = await workspace(t)
  const spec = join(root, 'workflow.json')
  const destination = join(root, 'contract.json')
  await symlink(bystander, destination)

  const result = await runCli(['--spec', spec, '--contract', destination, '--json'])
  assert.equal(result.code, 2, 'a destination that would destroy a file is a configuration error')
  assert.equal(result.stdout, '', 'a configuration error wrote a report on stdout')
  assert.match(result.stderr, /--contract is not usable/)
  assert.match(result.stderr, /is a symbolic link/)
  assert.doesNotMatch(result.stderr, /contract written/, 'the tool claimed a write it must not have made')
  assert.equal(await readFile(bystander, 'utf8'), BYSTANDER, 'the file outside the root was destroyed')
  assert.equal((await lstat(destination)).isSymbolicLink(), true, 'the link itself was replaced')
})

test('hole 1: a symbolic link aimed at a path that does not exist yet creates nothing', async (t) => {
  const { root, outside } = await workspace(t)
  const spec = join(root, 'workflow.json')
  const absent = join(outside, 'not-yet.json')
  const destination = join(root, 'contract.json')
  await symlink(absent, destination)

  // Nothing to overwrite is not the same as nothing to lose: following this
  // link creates a file outside the root, at a path the caller never named.
  const result = await runCli(['--spec', spec, '--contract', destination])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /is a symbolic link/)
  assert.equal(await exists(absent), false, 'a file was created outside the root')
})

test('hole 2: a symbolically linked parent does not widen the permitted root', async (t) => {
  const { root, outside, spec } = await workspace(t)
  // The root is resolved up front so that the lexical test is the only thing
  // that could let this destination through. On macOS the temporary directory
  // is itself a symbolic link, and an unresolved root would refuse every
  // destination for a reason that has nothing to do with this hole -- which
  // would leave the hole untested while the test still passed.
  const realRoot = await realpath(root)
  const escape = join(realRoot, 'escape')
  await symlink(outside, escape)
  const destination = join(escape, 'contract.json')

  // The premise: a prefix check on the path the caller typed says this
  // destination is inside the root. It is not, which is why the parent is
  // resolved first and compared afterwards.
  assert.equal(destination.startsWith(realRoot + sep), true, 'the fixture does not exercise the lexical hole')

  await assert.rejects(
    () => assertWritableDestination(destination, { inputs: [spec], root: realRoot, label: 'Contract destination' }),
    /outside the permitted root/,
  )
  // And the plain lexical escape, which a prefix check does catch, still is.
  await assert.rejects(
    () => assertWritableDestination(join(realRoot, '..', 'contract.json'), { inputs: [spec], root: realRoot, label: 'Contract destination' }),
    /outside the permitted root/,
  )
  assert.equal(await exists(join(outside, 'contract.json')), false)
})

test('hole 3: a hard link to the specification is refused and the specification survives', async (t) => {
  const { root, spec } = await workspace(t)
  const destination = join(root, 'contract.json')
  await link(spec, destination)

  const result = await runCli(['--spec', spec, '--contract', destination, '--json'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--contract is not usable/)
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(spec, 'utf8'), SPEC, 'the specification was overwritten through a hard link')
  assert.equal(await readFile(destination, 'utf8'), SPEC)
})

test('a destination that is a directory is refused rather than opened', async (t) => {
  const { root, spec } = await workspace(t)
  const destination = join(root, 'a-directory')
  await mkdir(destination)

  const result = await runCli(['--spec', spec, '--contract', destination])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /is not a regular file/)
  assert.equal((await lstat(destination)).isDirectory(), true)
})

test('the destinations that must stay allowed are still written', async (t) => {
  const { root, spec } = await workspace(t)
  const real = join(root, 'reports')
  await mkdir(real)

  for (const destination of [join(root, 'contract.json'), join(real, 'contract.json'), join(root, 'made', 'up', 'contract.json')]) {
    const result = await runCli(['--spec', spec, '--contract', destination, '--json'])
    assert.equal(result.code, 0, `a legitimate destination was refused: ${result.stderr}`)
    assert.match(result.stderr, /contract written/)
    assert.equal(JSON.parse(result.stdout).status, 'pass')
    const written = JSON.parse(await readFile(destination, 'utf8'))
    assert.equal(written.tool, 'workflow-step-contract-validator')
    assert.deepEqual(written.order, [{ stage: 0, steps: ['collect'] }, { stage: 1, steps: ['charge'] }])
  }
  assert.equal(await readFile(spec, 'utf8'), SPEC)
})

test('a root is a boundary, not a ban on links: a linked directory inside it is accepted', async (t) => {
  const { root, spec } = await workspace(t)
  const realRoot = await realpath(root)
  const real = join(realRoot, 'reports')
  await mkdir(real)
  const linked = join(realRoot, 'reports-link')
  await symlink(real, linked)

  // Reached through a symbolic link and still inside the root. Refusing this
  // would refuse every run under the macOS temporary directory, which is
  // itself a link -- the false refusal that makes a guard useless.
  const resolved = await assertWritableDestination(join(linked, 'contract.json'), {
    inputs: [spec],
    root: realRoot,
    label: 'Contract destination',
  })
  assert.equal(resolved, join(real, 'contract.json'))

  const plain = await assertWritableDestination(join(realRoot, 'contract.json'), {
    inputs: [spec],
    root: realRoot,
    label: 'Contract destination',
  })
  assert.equal(plain, join(realRoot, 'contract.json'))
})

test('an overwrite of a previous output of this tool is still allowed', async (t) => {
  const { root, spec } = await workspace(t)
  const destination = join(root, 'contract.json')
  await writeFile(destination, '{"stale": true}\n', 'utf8')

  const result = await runCli(['--spec', spec, '--contract', destination])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).tool, 'workflow-step-contract-validator')
})
