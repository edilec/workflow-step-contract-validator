/**
 * workflow-step-contract-validator
 *
 * Reads a workflow specification and decides, statically, whether its steps
 * can be wired together at all: whether every declared input has a producer,
 * whether the two sides of each binding agree on type, optionality and
 * version, and whether the dependency graph can be scheduled. Nothing is
 * executed, nothing is fetched, and no file is written except the execution
 * contract the caller explicitly asks for.
 *
 * Three properties are structural rather than incidental:
 *
 * 1. **An unanswered question is never a pass.** A declaration this tool could
 *    not read -- a malformed port, an unknown key, a limit reached -- makes the
 *    run `incomplete`. Incomplete is not a verdict in either direction; it says
 *    the evidence for one was not obtained.
 * 2. **The resolved order is deterministic.** Steps ready in the same round are
 *    emitted in code-unit order, so declaration order, object key order and the
 *    host's collation data cannot change the contract.
 * 3. **Everything from the document is untrusted.** Step ids, channel names,
 *    type names, versions, unknown keys and the workflow label are all
 *    sanitised on the way to output, because all of them are strings an author
 *    of the document chose.
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { resolveExecutionOrder } from './graph.mjs'
import {
  SPEC_SCHEMA_VERSION,
  compareVersions,
  isRecord,
  normalizeSpec,
  readSpecDocument,
  validateLimits,
} from './spec.mjs'
import { EXCERPT_LIMIT, LABEL_LIMIT, MESSAGE_LIMIT, byCodeUnit, sanitize } from './text.mjs'

export const TOOL_ID = 'workflow-step-contract-validator'
export const REPORT_SCHEMA_VERSION = '1'
export const CONTRACT_SCHEMA_VERSION = '1'

/** The two producers and consumers that are not steps. Neither can collide with
 * a step id: an identifier must start with a letter, and these do not. */
export const PROVIDED_PRODUCER = '(provided)'
export const WORKFLOW_CONSUMER = '(workflow)'

const DEFAULT_SOURCE = 'workflow.json'
const PATH_LIMIT = 240
const POINTER_LIMIT = 300

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Spread across construction sites as a literal it drifts silently, so
 * every finding takes its severity from here and an unknown rule id throws.
 *
 * This table is the source of truth; it is not the guard. Asserting it against
 * the documented catalog and against a hand-written map in a test is three
 * declarations agreeing with each other, and one coordinated edit satisfies
 * all three. `test/severity-behaviour.test.mjs` drives every rule through the
 * real entry point and pins the observable outcome instead.
 *
 * The policy this encodes: anything that would break at execution time is an
 * error -- a binding with no producer, two sides that disagree, a cycle.
 * Anything this tool could not read is an error too, and additionally makes
 * the run incomplete. A declaration nothing uses is information.
 */
export const RULE_SEVERITY = Object.freeze({
  'dependency-cycle': 'error',
  'dependency-malformed': 'error',
  'duplicate-producer': 'error',
  'graph-budget-exceeded': 'error',
  'graph-too-deep': 'error',
  'missing-producer': 'error',
  'no-steps-declared': 'warning',
  'optional-output-required-input': 'error',
  'output-unconsumed': 'info',
  'port-duplicated': 'error',
  'port-malformed': 'error',
  'port-name-invalid': 'error',
  'port-type-invalid': 'error',
  'producer-major-mismatch': 'error',
  'producer-version-too-low': 'error',
  'producer-version-unknown': 'warning',
  'provided-unused': 'info',
  'spec-malformed': 'error',
  'spec-not-json': 'error',
  'spec-not-utf8': 'error',
  'spec-too-large': 'error',
  'spec-unreadable': 'error',
  'step-id-duplicated': 'error',
  'step-id-invalid': 'error',
  'step-malformed': 'error',
  'step-unschedulable': 'error',
  'step-version-invalid': 'error',
  'time-budget-exceeded': 'error',
  'too-many-dependencies': 'error',
  'too-many-exports': 'error',
  'too-many-ports': 'error',
  'too-many-provided': 'error',
  'too-many-steps': 'error',
  'type-incompatible': 'error',
  'unknown-declaration-key': 'error',
  'unknown-dependency': 'error',
})

/**
 * The rules that mean a question could not be answered.
 *
 * Each of these marks the run `incomplete`, which is what keeps an unread
 * declaration from reporting a verdict. Two of them are only `warning`
 * severity -- `no-steps-declared` and `producer-version-unknown` -- so for
 * those this membership is the *only* thing standing between the run and a
 * green build. Every id here is driven through the real entry point in
 * `test/incompleteness.test.mjs`; removing one from this list turns exactly
 * one of those tests red.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'dependency-malformed',
  'graph-budget-exceeded',
  'graph-too-deep',
  'no-steps-declared',
  'port-duplicated',
  'port-malformed',
  'port-name-invalid',
  'port-type-invalid',
  'producer-version-unknown',
  'spec-malformed',
  'spec-not-json',
  'spec-not-utf8',
  'spec-too-large',
  'spec-unreadable',
  'step-id-duplicated',
  'step-id-invalid',
  'step-malformed',
  'step-version-invalid',
  'time-budget-exceeded',
  'too-many-dependencies',
  'too-many-exports',
  'too-many-ports',
  'too-many-provided',
  'too-many-steps',
  'unknown-declaration-key',
])

const INCOMPLETE = new Set(INCOMPLETE_RULES)
const ALLOWED_OPTIONS = Object.freeze(['bytes', 'clock', 'limits', 'source'])

function record(collector, row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) throw new TypeError(`No severity is declared for rule "${row.ruleId}"`)
  collector.rows.push({ ...row, severity, order: collector.rows.length })
  // One site, so that "which rules make a run incomplete" is a list a test can
  // enumerate rather than a property scattered through the analysis.
  if (INCOMPLETE.has(row.ruleId)) collector.incomplete = true
}

function createFinding(row, source) {
  const finding = {
    ruleId: row.ruleId,
    severity: row.severity,
    message: sanitize(row.message, MESSAGE_LIMIT),
    location: { file: source, pointer: sanitize(row.pointer, POINTER_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== null) finding.evidence = sanitize(row.evidence, EXCERPT_LIMIT)
  if (row.suggestion !== undefined && row.suggestion !== null) finding.suggestion = sanitize(row.suggestion, MESSAGE_LIMIT)
  return finding
}

/**
 * The documented sort key: `(location.pointer, ruleId, message)`.
 *
 * `location.file` is deliberately not part of it. Every finding in a run comes
 * from the one specification document, so sorting by it would compare a string
 * with itself -- an assertion that cannot fail is not a test, and a sort key
 * that cannot discriminate is not a sort key. Declaration order is the final
 * tiebreak so that two findings alike in every other respect keep a fixed
 * order.
 */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.pointer, right.pointer)
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message)
    || (left.order - right.order)
}

/**
 * The time budget, measured with a clock the caller supplies.
 *
 * `performance.now()` is a monotonic counter, not a wall clock, and the
 * elapsed value never reaches the report: the only thing it can change is
 * whether the budget was spent. A test injects its own clock to pin where the
 * budget is checked, and a budget of zero is spent before any work is done,
 * which is how the CLI's wiring is proved rather than assumed.
 */
function createDeadline(clock, maxMillis) {
  const started = clock()
  if (typeof started !== 'number' || !Number.isFinite(started)) {
    throw new TypeError('clock must return a finite number of milliseconds')
  }
  return { exceeded: () => clock() - started >= maxMillis }
}

function defaultClock() {
  return performance.now()
}

function label(value) {
  return sanitize(value, LABEL_LIMIT)
}

/**
 * Validate a workflow specification supplied as bytes.
 *
 * Configuration errors -- an unknown option, an unknown limit, a limit that is
 * not an integer -- throw. They mean the run never had a subject, so there is
 * nothing to report about, and the CLI turns them into exit 2 with an empty
 * stdout. Everything that is a fact about the *document* is a finding instead.
 */
export function analyzeWorkflow(input = {}) {
  if (!isRecord(input)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(input)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${sanitize(key, 60)}"`)
  }
  const limits = validateLimits(input.limits)
  const source = label(input.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
  const clock = input.clock ?? defaultClock
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')

  const deadline = createDeadline(clock, limits.maxMillis)
  const collector = { rows: [], incomplete: false }
  const state = {
    source,
    workflow: null,
    declaredSteps: 0,
    steps: [],
    channels: [],
    exports: [],
    stages: [],
    order: [],
    unresolved: [],
    cycles: 0,
    bindings: 0,
    unbound: 0,
  }

  if (deadline.exceeded()) {
    recordTimeout(collector, '/')
    return finish(collector, state)
  }

  const document = readSpecDocument(input.bytes, limits)
  if (!document.ok) {
    record(collector, {
      ruleId: document.ruleId,
      pointer: '/',
      message: document.message,
      evidence: document.evidence,
      suggestion: document.suggestion,
    })
    return finish(collector, state)
  }

  const spec = normalizeSpec(document.spec, limits)
  for (const problem of spec.problems) record(collector, problem)
  state.workflow = spec.workflow === null ? null : label(spec.workflow)
  state.declaredSteps = spec.declaredSteps
  if (spec.stopped) return finish(collector, state)
  // From here the steps have been read, so the contract can describe them even
  // if a later budget stops the run: "checked" counts the steps this run
  // actually looked at, and it is never inflated by the ones it did not.
  state.steps = spec.steps

  /**
   * Green on no evidence is a defect, not a clean bill of health. A workflow
   * that declares no steps was not validated; it was read. The finding alone
   * would not prevent a pass -- it is a warning -- so `no-steps-declared` is
   * also in INCOMPLETE_RULES, and that membership is the only thing between an
   * empty document and a green build.
   */
  if (spec.declaredSteps === 0) {
    record(collector, {
      ruleId: 'no-steps-declared',
      pointer: '/steps',
      message: 'The specification declares no steps, so this run checked no step contract.',
      suggestion: 'Point --spec at a workflow that declares at least one step.',
    })
  }

  const producers = buildProducers(spec, collector)
  const analysed = { spec, producers }
  if (deadline.exceeded()) {
    recordTimeout(collector, '/steps')
    return finish(collector, state, analysed)
  }

  const bound = bindConsumers(spec, producers, collector)
  state.bindings = bound.bindings
  state.unbound = bound.unbound

  if (deadline.exceeded()) {
    recordTimeout(collector, '/steps')
    return finish(collector, state, analysed)
  }

  const stepIds = new Set(spec.steps.map((step) => step.id))
  const dependencies = new Map(spec.steps.map((step) => [step.id, []]))
  for (const step of spec.steps) {
    for (const required of step.requires) {
      if (!stepIds.has(required)) {
        record(collector, {
          ruleId: 'unknown-dependency',
          pointer: `${step.pointer}/requires`,
          message: `Step "${label(step.id)}" requires "${label(required)}", which no step declares.`,
          evidence: required,
          suggestion: 'Declare that step, or correct the dependency.',
        })
        continue
      }
      dependencies.get(step.id).push(required)
    }
  }
  for (const edge of bound.edges) dependencies.get(edge.from).push(edge.to)

  const graph = resolveExecutionOrder([...stepIds], dependencies, {
    maxDepth: limits.maxDepth,
    maxGraphOperations: limits.maxGraphOperations,
    deadline,
  })
  for (const problem of graph.problems) {
    record(collector, { ruleId: problem.ruleId, pointer: '/steps', message: problem.message, suggestion: problem.suggestion })
  }
  for (const cycle of graph.cycles) {
    record(collector, {
      ruleId: 'dependency-cycle',
      pointer: `/steps/${cycle[0]}`,
      message: `Steps form a dependency cycle: ${[...cycle, cycle[0]].map(label).join(' -> ')}, where "X -> Y" means X depends on Y. None of them can be scheduled.`,
      suggestion: 'Break the cycle by removing a dependency or by splitting a step.',
    })
  }
  for (const id of graph.unschedulable) {
    record(collector, {
      ruleId: 'step-unschedulable',
      pointer: `/steps/${id}`,
      message: `Step "${label(id)}" depends, directly or through other steps, on a dependency cycle, so it can never run.`,
      suggestion: 'Break the cycle it waits behind.',
    })
  }

  reportUnused(spec, producers, collector)

  state.stages = graph.stages
  state.order = graph.order
  state.unresolved = graph.unresolved
  state.cycles = graph.cycles.length

  return finish(collector, state, analysed)
}

function recordTimeout(collector, pointer) {
  record(collector, {
    ruleId: 'time-budget-exceeded',
    pointer,
    message: 'Validation exceeded the maxMillis budget before it finished, so this workflow was not fully checked.',
    suggestion: 'Raise --max-millis deliberately, or reduce the size of the workflow.',
  })
}

/**
 * Index every declared producer by channel name.
 *
 * A channel with two producers is ambiguous: which value a consumer would
 * receive is a scheduling accident. The code-unit-first producer is used for
 * the compatibility check so the report is deterministic, and every other
 * producer of that channel is reported. `(provided)` sorts before any step id
 * because an identifier must begin with a letter, so a channel supplied to the
 * workflow always wins that tie -- and the step that shadows it is named.
 *
 * Owner alone is a total order here: the `provided` list and each step's
 * `outputs` list are already deduplicated by name (`port-duplicated`), and step
 * ids are deduplicated too (`step-id-duplicated`), so one owner can contribute
 * at most one producer of one channel. A second sort key would be a comparison
 * no input can reach, and code no input can reach is code no test can pin.
 */
function buildProducers(spec, collector) {
  const producers = new Map()
  const add = (entry) => {
    if (!producers.has(entry.name)) producers.set(entry.name, [])
    producers.get(entry.name).push(entry)
  }
  for (const port of spec.provided) {
    add({ ...port, owner: PROVIDED_PRODUCER, fromStep: false, version: null, consumers: [] })
  }
  for (const step of spec.steps) {
    for (const port of step.outputs) {
      add({ ...port, owner: step.id, fromStep: true, version: step.version, consumers: [] })
    }
  }
  for (const [name, entries] of producers) {
    entries.sort((left, right) => byCodeUnit(left.owner, right.owner))
    for (const duplicate of entries.slice(1)) {
      record(collector, {
        ruleId: 'duplicate-producer',
        pointer: duplicate.pointer,
        message: `Channel "${label(name)}" is produced by ${label(duplicate.owner)} and by ${label(entries[0].owner)}, so which value a consumer receives is undefined.`,
        suggestion: 'Rename one of the two channels, or remove one producer.',
      })
    }
  }
  return producers
}

/**
 * Check every consumer against the producer of the channel it names.
 *
 * The optional case is the subtle one and it is asymmetric on purpose. An
 * output the producer may or may not emit satisfies a consumer that says it
 * can cope with the absence, and does not satisfy one that requires the value:
 * that consumer would fail at run time on exactly the branch where the
 * producer stays silent, which is the branch nobody tests.
 */
function bindConsumers(spec, producers, collector) {
  const edges = []
  let bindings = 0
  let unbound = 0

  const consumers = []
  for (const step of spec.steps) {
    for (const port of step.inputs) consumers.push({ owner: step.id, fromStep: true, port })
  }
  for (const port of spec.exports) consumers.push({ owner: WORKFLOW_CONSUMER, fromStep: false, port })

  for (const consumer of consumers) {
    const { port, owner } = consumer
    const entries = producers.get(port.name)
    const who = consumer.fromStep ? `Step "${label(owner)}"` : 'The workflow export'
    if (entries === undefined) {
      unbound += 1
      record(collector, {
        ruleId: 'missing-producer',
        pointer: port.pointer,
        message: `${who} consumes channel "${label(port.name)}", which no step produces and the workflow does not provide.`,
        suggestion: 'Declare it as an output of an earlier step, or list it under "provided".',
      })
      continue
    }
    const producer = entries[0]
    bindings += 1
    producer.consumers.push(owner)

    if (producer.type !== null && port.type !== null && producer.type !== port.type) {
      record(collector, {
        ruleId: 'type-incompatible',
        pointer: port.pointer,
        message: `${who} declares channel "${label(port.name)}" as ${label(port.type)}, but ${label(producer.owner)} produces it as ${label(producer.type)}.`,
        suggestion: 'Make the two declarations agree; this tool compares type names exactly and never assumes two names mean the same type.',
      })
    }
    if (producer.optional && !port.optional) {
      record(collector, {
        ruleId: 'optional-output-required-input',
        pointer: port.pointer,
        message: `${who} requires channel "${label(port.name)}", but ${label(producer.owner)} only optionally produces it, so the value can be absent when the step runs.`,
        suggestion: 'Mark this consumer optional, or make the producer always emit the channel.',
      })
    }
    if (port.minVersion !== null) {
      checkVersion(consumer, producer, who, collector)
    }
    if (consumer.fromStep && producer.fromStep) edges.push({ from: owner, to: producer.owner })
  }
  return { edges, bindings, unbound }
}

function checkVersion(consumer, producer, who, collector) {
  const { port } = consumer
  const wanted = port.minVersion.join('.')
  if (!producer.fromStep || producer.version === null) {
    record(collector, {
      ruleId: 'producer-version-unknown',
      pointer: port.pointer,
      message: `${who} requires channel "${label(port.name)}" at version ${wanted} or later, but the version of ${label(producer.owner)} is not known, so the constraint was not checked.`,
      suggestion: 'Give the producing step a major.minor.patch version, or drop the minVersion constraint.',
    })
    return
  }
  const found = producer.version.join('.')
  if (producer.version[0] !== port.minVersion[0]) {
    record(collector, {
      ruleId: 'producer-major-mismatch',
      pointer: port.pointer,
      message: `${who} requires channel "${label(port.name)}" from a ${port.minVersion[0]}.x producer, but ${label(producer.owner)} is version ${found}; a different major version is not compatible.`,
      suggestion: 'Update the constraint deliberately, or pin the producer to the required major version.',
    })
    return
  }
  if (compareVersions(producer.version, port.minVersion) < 0) {
    record(collector, {
      ruleId: 'producer-version-too-low',
      pointer: port.pointer,
      message: `${who} requires channel "${label(port.name)}" at version ${wanted} or later, but ${label(producer.owner)} is version ${found}.`,
      suggestion: 'Upgrade the producing step, or lower the constraint deliberately.',
    })
  }
}

/**
 * Report declarations nothing uses.
 *
 * These are information, not defects: an output no step consumes is often a
 * result the workflow deliberately leaves on the floor. A duplicate producer
 * is skipped here -- it was already reported as a duplicate, and saying its
 * output is unconsumed as well would describe the same defect twice.
 */
function reportUnused(spec, producers, collector) {
  for (const entries of producers.values()) {
    const producer = entries[0]
    if (producer.consumers.length > 0) continue
    if (producer.fromStep) {
      record(collector, {
        ruleId: 'output-unconsumed',
        pointer: producer.pointer,
        message: `Step "${label(producer.owner)}" produces channel "${label(producer.name)}", which no step consumes and the workflow does not export.`,
        suggestion: 'Consume it, export it, or remove the output.',
      })
    } else {
      record(collector, {
        ruleId: 'provided-unused',
        pointer: producer.pointer,
        message: `The workflow provides channel "${label(producer.name)}", which no step consumes and the workflow does not export.`,
        suggestion: 'Consume it or remove it from "provided".',
      })
    }
  }
}

function finish(collector, state, analysed) {
  collector.rows.sort(compareFindingRows)
  const findings = collector.rows.map((row) => createFinding(row, state.source))
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  const stageOf = new Map(state.order.map((entry) => [entry.id, entry.stage]))
  const channels = analysed === undefined ? [] : describeChannels(analysed.producers)
  const summary = {
    checked: state.steps.length,
    errors,
    warnings,
    info: findings.length - errors - warnings,
    steps: state.declaredSteps,
    channels: channels.length,
    bindings: state.bindings,
    unbound: state.unbound,
    resolved: state.order.length,
    unresolved: state.unresolved.length,
    cycles: state.cycles,
  }

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary,
    findings,
  }

  const contract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tool: TOOL_ID,
    specSchemaVersion: SPEC_SCHEMA_VERSION,
    workflow: state.workflow,
    source: state.source,
    status,
    complete: status !== 'incomplete',
    counts: {
      steps: summary.steps,
      checked: summary.checked,
      channels: summary.channels,
      bindings: summary.bindings,
      unbound: summary.unbound,
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      cycles: summary.cycles,
    },
    order: state.stages.map((ids, stage) => ({ stage, steps: ids.map(label) })),
    unresolved: state.unresolved.map(label),
    steps: analysed === undefined ? [] : describeSteps(analysed.spec, analysed.producers, stageOf),
    exports: analysed === undefined ? [] : analysed.spec.exports.map((port) => describeBinding(port, analysed.producers)),
    channels,
  }

  return { report, contract }
}

/**
 * Describe one consumer and the producer it resolved to.
 *
 * `resolved: false` is the whole point of listing an unresolved binding: a
 * contract that silently omitted it would read as if the step had one fewer
 * requirement than it declared.
 */
function describeBinding(port, producers) {
  const producer = producers.get(port.name)?.[0]
  return {
    name: label(port.name),
    type: port.type === null ? null : label(port.type),
    optional: port.optional,
    minVersion: port.minVersion === null ? null : port.minVersion.join('.'),
    from: producer === undefined ? null : label(producer.owner),
    resolved: producer !== undefined,
  }
}

function describeSteps(spec, producers, stageOf) {
  return spec.steps.map((step) => ({
    id: label(step.id),
    version: step.version === null ? null : step.version.join('.'),
    stage: stageOf.has(step.id) ? stageOf.get(step.id) : null,
    consumes: step.inputs.map((port) => describeBinding(port, producers)),
    produces: step.outputs.map((port) => ({
      name: label(port.name),
      type: port.type === null ? null : label(port.type),
      optional: port.optional,
    })),
  }))
}

function describeChannels(producers) {
  const channels = []
  for (const [name, entries] of producers) {
    const producer = entries[0]
    channels.push({
      name: label(name),
      type: producer.type === null ? null : label(producer.type),
      optional: producer.optional,
      producer: label(producer.owner),
      producers: entries.length,
      consumers: [...new Set(producer.consumers)].sort(byCodeUnit).map(label),
    })
  }
  channels.sort((left, right) => byCodeUnit(left.name, right.name))
  return channels
}

/**
 * Read a specification from a file and validate it.
 *
 * A file that could not be read is an input failure, not a configuration
 * failure: the run had a subject and failed to obtain evidence about it. That
 * is what `incomplete` exists to say, and a consumer needs the report to know
 * which input was not read.
 */
export async function validateWorkflowFile(path, options = {}) {
  let bytes
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch (error) {
    const source = label(options.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
    const collector = { rows: [], incomplete: false }
    record(collector, {
      ruleId: 'spec-unreadable',
      pointer: '/',
      message: `The specification could not be read: ${String(error.code ?? error.message)}.`,
      suggestion: 'Check the path and the file permissions.',
    })
    return finish(collector, {
      source,
      workflow: null,
      declaredSteps: 0,
      steps: [],
      stages: [],
      order: [],
      unresolved: [],
      cycles: 0,
      bindings: 0,
      unbound: 0,
    })
  }
  return analyzeWorkflow({ ...options, bytes })
}

const ANCESTOR_PROBE_LIMIT = 64

/**
 * Resolve the execution contract's destination, and refuse the specification.
 *
 * The contract is a derived artifact. Writing it over the document it was
 * derived from destroys the input, irreversibly, and no comparison of *paths*
 * prevents that. A symbolic link has a target, so `realpath` collapses it -- but
 * a **hard link has no target**. Two names for one inode resolve to two
 * different real paths, so a `realpath` comparison says they are different files
 * and the write destroys the specification. Hard links are routine in build
 * trees: `cp -l`, package-store linking and de-duplicating backups all make
 * them. So identity is decided the way the filesystem decides it, by device and
 * inode, read with `bigint: true` because an inode number can exceed what a
 * double represents exactly.
 *
 * The resolved-path comparison is kept as well, for a filesystem that reports no
 * inode number at all (`ino` of zero), where the dev/ino test cannot answer.
 *
 * The destination usually does not exist yet, so its nearest existing ancestor
 * is resolved and the remaining segments are appended. Resolving the ancestor
 * rather than refusing the unresolvable path is the other half of the same
 * defect: a destination under a symlinked directory -- which is what the
 * system temporary directory is on macOS -- is a legitimate destination, and
 * refusing it would be a bug of its own. A destination that does not exist
 * cannot be the specification, which does.
 */
export async function resolveContractDestination(specPath, destination) {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new TypeError('Contract destination must be a non-empty path')
  }
  const absolute = resolve(destination)
  const tail = []
  let probe = absolute
  let realBase = null

  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    try {
      realBase = await realpath(probe)
      break
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new TypeError(`Contract destination could not be resolved: ${error.code ?? 'unknown error'}`)
      }
      const parent = dirname(probe)
      if (parent === probe) throw new TypeError('Contract destination has no existing ancestor directory')
      tail.unshift(basename(probe))
      probe = parent
    }
  }
  if (realBase === null) throw new TypeError('Contract destination is nested too deeply to resolve')

  const resolved = tail.length === 0 ? realBase : join(realBase, ...tail)
  let specReal
  let specStat
  try {
    specReal = await realpath(specPath)
    specStat = await stat(specPath, { bigint: true })
  } catch (error) {
    throw new TypeError(`The specification could not be resolved: ${error.code ?? 'unknown error'}`)
  }

  let destinationStat = null
  try {
    destinationStat = await stat(resolved, { bigint: true })
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw new TypeError(`Contract destination could not be resolved: ${error.code ?? 'unknown error'}`)
    }
  }
  const sameFile = destinationStat !== null
    && destinationStat.ino !== 0n
    && destinationStat.ino === specStat.ino
    && destinationStat.dev === specStat.dev
  if (sameFile || resolved === specReal) {
    throw new TypeError(
      'Contract destination is the specification itself; the contract is a derived artifact and must be written elsewhere',
    )
  }
  return resolved
}

/** Serialise the execution contract. The specification is never written to. */
export async function writeContractFile(destination, contract) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  return destination
}

const SEVERITY_WIDTH = 7

export function formatReport(report, contract) {
  const { summary } = report
  const name = contract?.workflow ? `"${contract.workflow}"` : '(unnamed workflow)'
  const lines = [
    `workflow ${name}: ${summary.checked} step(s) checked of ${summary.steps} declared, `
    + `${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `${summary.channels} channel(s), ${summary.bindings} binding(s), ${summary.unbound} unbound, `
    + `${summary.resolved} step(s) ordered, ${summary.unresolved} unresolved, ${summary.cycles} cycle(s).`,
  ]
  if (contract !== undefined && contract.order.length > 0) {
    lines.push(`order: ${contract.order.map((stage) => `[${stage.stage}] ${stage.steps.join(', ')}`).join(' | ')}`)
  }
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${finding.location.file}${finding.location.pointer} `
      + `${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { DEFAULT_LIMITS, NAME_LIMIT, NAME_PATTERN, TYPE_PATTERN, VERSION_PATTERN, normalizeSpec, readSpecDocument } from './spec.mjs'
export { byCodeUnit, decodeUtf8, sanitize } from './text.mjs'
export { resolveExecutionOrder } from './graph.mjs'
