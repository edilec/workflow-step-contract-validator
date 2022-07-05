#!/usr/bin/env node

import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  formatReport,
  resolveContractDestination,
  validateWorkflowFile,
  writeContractFile,
} from '../src/index.mjs'

const HELP = `workflow-step-contract-validator

Validate a workflow DAG statically: every declared input has a producer, the
two sides of every binding agree on type, optionality and version, and the
dependency graph can be scheduled. Nothing is executed and nothing is fetched.

Usage:
  workflow-step-contract-validator --spec FILE [--contract FILE] [--json] [limits]

Options:
  --spec FILE                   Workflow specification to validate (required)
  --contract FILE               Write the typed execution contract here. A
                                destination that is not the file it names is
                                refused: a symbolic link, a path whose parent
                                leaves the permitted tree, a directory, or any
                                file this run reads -- including one reached by
                                a hard link, which shares no path with its input
  --json                        Emit the machine-readable report on stdout
  --max-bytes N                 Maximum specification size (default 1048576)
  --max-steps N                 Maximum declared steps (default 500)
  --max-ports-per-step N        Maximum inputs plus outputs per step (default 64)
  --max-dependencies-per-step N Maximum "requires" entries per step (default 64)
  --max-provided N              Maximum provided channels (default 200)
  --max-exports N               Maximum exports (default 200)
  --max-depth N                 Maximum execution stages and traversal depth (default 64)
  --max-graph-operations N      Graph traversal budget (default 200000)
  --max-millis N                Validation time budget in milliseconds (default 5000)
  -h, --help                    Show this help

Every option is accepted once: a repeated flag is a configuration error, not a
silent last-wins. An unknown option is refused rather than ignored, because a
typo that turns into a default is a real failure reported as a green run.

A limit that is reached is reported by name and makes the run incomplete. The
declaration that exceeded it is refused whole -- a document-level limit refuses
the document, a step-level limit refuses the step. Nothing is truncated.

Exit codes:
  0  every step contract checked out
  1  the workflow is unschedulable or incompatible as declared
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, unreadable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-bytes', 'maxBytes'],
  ['--max-steps', 'maxSteps'],
  ['--max-ports-per-step', 'maxPortsPerStep'],
  ['--max-dependencies-per-step', 'maxDependenciesPerStep'],
  ['--max-provided', 'maxProvided'],
  ['--max-exports', 'maxExports'],
  ['--max-depth', 'maxDepth'],
  ['--max-graph-operations', 'maxGraphOperations'],
  ['--max-millis', 'maxMillis'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { spec: null, contract: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--spec a --spec b` validates a document nobody named and `--max-steps 10
   * --max-steps 10000` enforces a bound nobody asked for.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--spec') {
      once('--spec')
      options.spec = takeValue('--spec')
    } else if (argument === '--contract') {
      once('--contract')
      options.contract = takeValue('--contract')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const floor = argument === '--max-millis' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < floor) {
        throw new Error(`${argument} requires an integer of at least ${floor}`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else {
      throw new Error(`Unknown option "${argument}"`)
    }
  }

  if (options.spec === null) throw new Error('--spec is required')
  return options
}

/**
 * The label a finding carries.
 *
 * `location.file` is never an absolute host path: a report is an artifact
 * people paste into issues and diff between machines. A specification inside
 * the working directory is named relative to it, and anything else is named by
 * its base name alone.
 */
function sourceLabel(specPath) {
  const absolute = resolve(specPath)
  const fromHere = relative(process.cwd(), absolute)
  if (fromHere === '' || fromHere.startsWith('..') || isAbsolute(fromHere)) return absolute.split(/[\\/]/).pop()
  return fromHere.split('\\').join('/')
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  // Configuration is settled before the specification is read, so a bad limit
  // or a destination pointing at the input fails with no report at all rather
  // than half way through a run.
  let destination = null
  if (options.contract !== null) {
    try {
      destination = await resolveContractDestination(options.spec, options.contract)
    } catch (error) {
      process.stderr.write(`--contract is not usable: ${error.message}\n`)
      return 2
    }
  }

  let report
  let contract
  try {
    const result = await validateWorkflowFile(options.spec, {
      source: sourceLabel(options.spec),
      limits: options.limits,
      // The clock the documented time budget is measured with. Wiring it here
      // is the difference between a limit that is enforced and one that is
      // merely written down.
      clock: () => performance.now(),
    })
    report = result.report
    contract = result.contract
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  if (destination !== null) {
    try {
      await writeContractFile(destination, contract)
      process.stderr.write(
        `contract written: ${contract.counts.checked} step(s), ${contract.counts.resolved} ordered, complete=${contract.complete}\n`,
      )
    } catch (error) {
      process.stderr.write(`contract could not be written: ${error.code ?? error.message}\n`)
      return 2
    }
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, contract))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.steps} declared step(s) were analysed; this run is not a verdict.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
