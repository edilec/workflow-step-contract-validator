/**
 * The write guard.
 *
 * A tool that writes an artifact can destroy a file nobody asked it to touch.
 * Three holes make that happen, they are independent, and closing one or two is
 * what every tool that lost data in this catalog had already done:
 *
 * 1. **A symbolic link at the destination.** The write follows the link, so the
 *    bytes land wherever the link points -- which is not the path the caller
 *    named. `realpath` on the destination does not help: it *resolves* the
 *    link, and resolving is precisely the dangerous act. The link is refused on
 *    sight, by `lstat`, before anything is opened. This also covers a link
 *    aimed at a path that does not exist yet, which otherwise creates a file
 *    somewhere the caller never named.
 * 2. **A symbolically linked parent directory.** The same escape one level up,
 *    and a lexical prefix test passes for `root/link/out` where `link` leaves
 *    the root. So the parent is resolved first and compared afterwards, never
 *    compared as a string.
 * 3. **A hard link to an input.** It has no target to resolve and shares no
 *    path with the input, so `realpath` and string comparison both call it a
 *    different file. It is the same file. Only device plus inode sees that,
 *    read with `bigint: true` because an inode number can exceed what a double
 *    represents exactly.
 *
 * A refused destination is a configuration error: the caller exits 2 and
 * writes no report at all.
 *
 * Two adaptations to the destination a legitimate caller names, because a
 * guard that refuses everything passes a data-loss test while making the tool
 * useless:
 *
 * - The destination usually does not exist yet, and neither does its parent:
 *   this tool creates intermediate directories. So the nearest *existing*
 *   ancestor is resolved and the segments that do not exist yet are appended.
 *   They cannot be links; nothing is there to link.
 * - A resolved parent that is inside the root is accepted even though it was
 *   reached through a symbolic link. On macOS the system temporary directory
 *   is itself a symbolic link, so the opposite rule would refuse every run in
 *   it. What is refused is leaving the root, not passing through a link.
 */

import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Raised when a destination cannot be written to safely. The caller exits 2. */
export class DestinationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

const ANCESTOR_PROBE_LIMIT = 64

/**
 * The real directory the destination would be written into.
 *
 * Resolved, never assembled from the string the caller typed, so hole 2 is
 * answered by the filesystem rather than by a prefix test.
 */
async function resolveParentDirectory(target, label) {
  const tail = []
  let probe = dirname(target)

  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    let real = null
    try {
      real = await realpath(probe)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new DestinationError(`${label} could not be resolved: ${error.code ?? 'unknown error'}`)
      }
      const parent = dirname(probe)
      if (parent === probe) throw new DestinationError(`${label} names a directory that does not exist`)
      tail.unshift(basename(probe))
      probe = parent
      continue
    }
    return tail.length === 0 ? real : join(real, ...tail)
  }
  throw new DestinationError(`${label} is nested too deeply to resolve`)
}

/**
 * Refuse an output destination that would write somewhere the caller did not
 * name, or over something this tool is reading, and return the real path to
 * write instead.
 *
 * `inputs` are paths this tool reads; `root`, when given, is the only directory
 * tree the output may land in; `label` names the option in the diagnostic.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], root = null, label = '--contract' } = options
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target, { bigint: true })
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} is a symbolic link, so writing through it would put the output wherever the link points `
      + `rather than at the path you named. It is refused unresolved, because resolving it is the dangerous `
      + `act. Name the real destination.`,
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} exists and is not a regular file`)
  }

  const parent = await resolveParentDirectory(target, label)

  if (root !== null) {
    let base
    try {
      base = await realpath(resolve(root))
    } catch (error) {
      throw new DestinationError(`the permitted root could not be resolved: ${error.code ?? 'unknown error'}`)
    }
    if (parent !== base && !parent.startsWith(base + sep)) {
      throw new DestinationError(
        `${label} resolves into ${parent}, which is outside the permitted root. A link or a ".." segment `
        + `on the way there does not widen it.`,
      )
    }
  }

  const resolved = join(parent, basename(target))
  if (existing === null) return resolved

  // Same file as an input? Ask the filesystem, not the path.
  for (const input of inputs) {
    let source
    try {
      source = await stat(input, { bigint: true })
    } catch {
      continue
    }
    if (source.ino !== 0n && source.dev === existing.dev && source.ino === existing.ino) {
      throw new DestinationError(
        `${label} is the same file as an input: they share device ${existing.dev} and inode ${existing.ino}, `
        + `so a hard link does not make them two files. This tool never rewrites what it reads, and the `
        + `contract is a derived artifact that must be written elsewhere.`,
      )
    }
  }
  return resolved
}
