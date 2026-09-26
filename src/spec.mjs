/**
 * The workflow specification document: its limits, its grammar, and the
 * normalisation that turns it into declarations this tool can reason about.
 *
 * Nothing in this module executes a step, resolves a path, or reads a clock.
 * It answers one question -- what did this document actually declare -- and
 * records a problem for every part of it that could not be understood. A part
 * that could not be understood is never quietly defaulted: the caller turns
 * each problem into a finding, and the rules that mean "this question could
 * not be answered" mark the whole run incomplete.
 */

import { byCodeUnit, decodeUtf8, parseFailureDetail, sanitize } from './text.mjs'

export const SPEC_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A specification is ordinary untrusted input: it can be a generated 40 MB
 * document, ten thousand steps, or a graph shaped so that cycle detection
 * walks forever. Every limit is explicit, overridable from the CLI, and named
 * in the finding when it is reached. Exceeding one produces an `incomplete`
 * report -- never a quietly shorter answer, and never a pass.
 *
 * `maxMillis` is the only limit that may be zero: a budget of zero is spent
 * before any work is done, which is how the CLI's clock wiring is proved
 * rather than assumed.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1048576,
  maxSteps: 500,
  maxPortsPerStep: 64,
  maxDependenciesPerStep: 64,
  maxProvided: 200,
  maxExports: 200,
  maxDepth: 64,
  maxGraphOperations: 200000,
  maxMillis: 5000,
})

/** The one limit measured in time, and so the one limit allowed to be zero. */
const ZERO_ALLOWED = Object.freeze(['maxMillis'])

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A one-character typo that
 * is silently dropped leaves the default in force while the operator believes
 * a stricter bound is being enforced, which is how a documented limit stops
 * being enforced without anyone noticing.
 */
export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${sanitize(name, 60)}"`)
    const floor = ZERO_ALLOWED.includes(name) ? 0 : 1
    if (!Number.isInteger(value) || value < floor) {
      throw new TypeError(`Limit "${name}" must be an integer of at least ${floor}`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

/**
 * The grammar of an identifier.
 *
 * A step id, a channel name and a type name are all identifiers: they name
 * something a person and another tool both have to be able to refer to. The
 * pattern is deliberately narrow -- an identifier that does not match is
 * reported rather than sanitised into something that happens to be valid,
 * because silently renaming a declaration would change which channel it binds.
 *
 * The narrowness is also what makes a JSON Pointer safe to build by
 * interpolation. `/` and `~` are the two characters RFC 6901 has to escape, and
 * neither is in this grammar, so an id that reaches a pointer needs no escaping
 * and an id that would have needed it never reaches one -- it is reported at an
 * index-based pointer instead. That is a property of the refusal, so
 * `test/sanitising.test.mjs` asserts the refusal and the shape of every pointer
 * a run emits, rather than an escaping helper nothing calls.
 */
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/
export const TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*(?:\[\])?$/
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const NAME_LIMIT = 100

export const WORKFLOW_KEYS = Object.freeze(['description', 'exports', 'provided', 'schemaVersion', 'steps', 'workflow'])
export const STEP_KEYS = Object.freeze(['description', 'id', 'inputs', 'outputs', 'requires', 'version'])
export const CONSUMER_KEYS = Object.freeze(['description', 'minVersion', 'name', 'optional', 'type'])
export const PRODUCER_KEYS = Object.freeze(['description', 'name', 'optional', 'type'])

/** Parse a strict `major.minor.patch` version. Anything else is not guessed. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = VERSION_PATTERN.exec(value)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two parsed versions numerically. */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * Read the specification document from bytes.
 *
 * Byte length is checked before decoding, decoding is strict, and parsing is
 * the last step. Each failure names the document rather than guessing at its
 * contents, and every one of them makes the run incomplete: a document that
 * was not read is not evidence that the workflow is sound.
 */
export function readSpecDocument(bytes, limits) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Specification bytes must be a Uint8Array')
  if (bytes.byteLength > limits.maxBytes) {
    return {
      ok: false,
      ruleId: 'spec-too-large',
      message: `The specification is ${bytes.byteLength} bytes, over the maxBytes budget of ${limits.maxBytes}; it was not read.`,
      suggestion: 'Raise --max-bytes deliberately, or split the workflow into smaller specifications.',
    }
  }
  const decoded = decodeOrFail(bytes)
  if (!decoded.ok) return decoded
  try {
    return { ok: true, spec: JSON.parse(decoded.text) }
  } catch (error) {
    return {
      ok: false,
      ruleId: 'spec-not-json',
      message: 'The specification is not valid JSON, so nothing about this workflow was checked.',
      evidence: parseFailureDetail(error),
    }
  }
}

function decodeOrFail(bytes) {
  const decoded = decodeUtf8(bytes)
  if (decoded.ok) return decoded
  return {
    ok: false,
    ruleId: 'spec-not-utf8',
    message: 'The specification is not valid UTF-8, so nothing about this workflow was checked.',
    suggestion: 'Re-encode the specification as UTF-8.',
  }
}

function problem(ruleId, pointer, message, extra = {}) {
  return { ruleId, pointer, message, ...extra }
}

/**
 * Normalise one declared port.
 *
 * A port whose name cannot be read is dropped: binding it would mean inventing
 * a channel name, and every invention here is a compatibility question
 * answered without evidence. A port whose *type* cannot be read is kept with a
 * null type, because the binding itself is still a fact worth reporting -- the
 * type comparison is the only thing skipped, and the rule that reported the
 * bad type has already made the run incomplete.
 */
function normalizePort(raw, context) {
  const { index, pointerBase, allowedKeys, owner, kind, problems } = context
  const at = `${pointerBase}/${index}`
  if (!isRecord(raw)) {
    problems.push(problem('port-malformed', at, `${owner} declares a ${kind} that is ${describe(raw)} rather than an object.`))
    return null
  }
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) {
      problems.push(problem(
        'unknown-declaration-key',
        at,
        `${owner} declares an unknown key "${sanitize(key, NAME_LIMIT)}" on a ${kind}; its intent could not be read.`,
        { suggestion: `Remove it or correct the spelling. Allowed keys: ${allowedKeys.join(', ')}.` },
      ))
    }
  }
  if (typeof raw.name !== 'string' || raw.name.length > NAME_LIMIT || !NAME_PATTERN.test(raw.name)) {
    problems.push(problem(
      'port-name-invalid',
      at,
      `${owner} declares a ${kind} whose name is not an identifier, so it binds to no channel.`,
      { evidence: typeof raw.name === 'string' ? raw.name : describe(raw.name) },
    ))
    return null
  }
  const name = raw.name
  const portPointer = `${pointerBase}/${name}`
  let type = null
  if (typeof raw.type !== 'string' || !TYPE_PATTERN.test(raw.type) || raw.type.length > NAME_LIMIT) {
    problems.push(problem(
      'port-type-invalid',
      portPointer,
      `${owner} declares ${kind} "${sanitize(name, NAME_LIMIT)}" without a readable type, so its compatibility could not be decided.`,
      { evidence: typeof raw.type === 'string' ? raw.type : describe(raw.type) },
    ))
  } else {
    type = raw.type
  }
  let optional = false
  if (raw.optional !== undefined) {
    if (typeof raw.optional !== 'boolean') {
      problems.push(problem(
        'port-malformed',
        portPointer,
        `${owner} declares ${kind} "${sanitize(name, NAME_LIMIT)}" with a non-boolean optional flag, so whether it may be absent is unknown.`,
        { evidence: describe(raw.optional) },
      ))
    } else {
      optional = raw.optional
    }
  }
  let minVersion = null
  if (raw.minVersion !== undefined && allowedKeys.includes('minVersion')) {
    minVersion = parseVersion(raw.minVersion)
    if (minVersion === null) {
      problems.push(problem(
        'port-malformed',
        portPointer,
        `${owner} declares ${kind} "${sanitize(name, NAME_LIMIT)}" with a minVersion that is not a major.minor.patch version.`,
        { evidence: typeof raw.minVersion === 'string' ? raw.minVersion : describe(raw.minVersion) },
      ))
    }
  }
  return { name, type, optional, minVersion, pointer: portPointer }
}

function normalizePortList(rawList, context) {
  const ports = []
  const seen = new Set()
  for (let index = 0; index < rawList.length; index += 1) {
    const port = normalizePort(rawList[index], { ...context, index })
    if (port === null) continue
    if (seen.has(port.name)) {
      context.problems.push(problem(
        'port-duplicated',
        port.pointer,
        `${context.owner} declares ${context.kind} "${sanitize(port.name, NAME_LIMIT)}" more than once, so which declaration applies is unknown.`,
      ))
      continue
    }
    seen.add(port.name)
    ports.push(port)
  }
  return ports
}

function readList(raw, name, pointer, problems) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problems.push(problem('spec-malformed', pointer, `The "${name}" declaration is ${describe(raw)} rather than an array.`))
    return []
  }
  return raw
}

/**
 * Normalise the whole document.
 *
 * Two shapes of refusal live here. A document-level limit refuses the
 * *document*: analysing the first N of too many steps would report missing
 * producers for every binding into the part that was dropped, which is a
 * fabricated verdict. A step-level limit refuses the *step*. Neither
 * truncates.
 */
export function normalizeSpec(spec, limits) {
  const problems = []
  if (!isRecord(spec)) {
    problems.push(problem('spec-malformed', '/', `The specification is ${describe(spec)} rather than an object.`))
    return { stopped: true, problems, workflow: null, declaredSteps: 0, steps: [], provided: [], exports: [] }
  }
  for (const key of Object.keys(spec)) {
    if (!WORKFLOW_KEYS.includes(key)) {
      problems.push(problem(
        'unknown-declaration-key',
        '/',
        `The specification declares an unknown top-level key "${sanitize(key, NAME_LIMIT)}"; its intent could not be read.`,
        { suggestion: `Remove it or correct the spelling. Allowed keys: ${WORKFLOW_KEYS.join(', ')}.` },
      ))
    }
  }
  if (spec.schemaVersion !== SPEC_SCHEMA_VERSION) {
    problems.push(problem(
      'spec-malformed',
      '/schemaVersion',
      `The specification declares schemaVersion ${JSON.stringify(sanitize(String(spec.schemaVersion ?? 'missing'), NAME_LIMIT))}; this tool reads version "${SPEC_SCHEMA_VERSION}".`,
    ))
    return { stopped: true, problems, workflow: null, declaredSteps: 0, steps: [], provided: [], exports: [] }
  }
  let workflow = null
  if (spec.workflow !== undefined) {
    if (typeof spec.workflow !== 'string') {
      problems.push(problem('spec-malformed', '/workflow', `The workflow name is ${describe(spec.workflow)} rather than a string.`))
    } else {
      workflow = spec.workflow
    }
  }
  if (!Array.isArray(spec.steps)) {
    problems.push(problem('spec-malformed', '/steps', `The "steps" declaration is ${describe(spec.steps)} rather than an array.`))
    return { stopped: true, problems, workflow, declaredSteps: 0, steps: [], provided: [], exports: [] }
  }

  const rawProvided = readList(spec.provided, 'provided', '/provided', problems)
  const rawExports = readList(spec.exports, 'exports', '/exports', problems)
  const overruns = [
    ['too-many-steps', '/steps', spec.steps.length, limits.maxSteps, 'steps', 'maxSteps'],
    ['too-many-provided', '/provided', rawProvided.length, limits.maxProvided, 'provided channels', 'maxProvided'],
    ['too-many-exports', '/exports', rawExports.length, limits.maxExports, 'exports', 'maxExports'],
  ].filter(([, , count, limit]) => count > limit)
  if (overruns.length > 0) {
    for (const [ruleId, pointer, count, limit, what, limitName] of overruns) {
      problems.push(problem(
        ruleId,
        pointer,
        `The specification declares ${count} ${what}, over the ${limitName} budget of ${limit}; the document was not analysed.`,
        { suggestion: `Raise --${limitName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} deliberately, or split the workflow.` },
      ))
    }
    return { stopped: true, problems, workflow, declaredSteps: spec.steps.length, steps: [], provided: [], exports: [] }
  }

  const provided = normalizePortList(rawProvided, {
    pointerBase: '/provided',
    allowedKeys: PRODUCER_KEYS,
    owner: 'The workflow',
    kind: 'provided channel',
    problems,
  })
  const exported = normalizePortList(rawExports, {
    pointerBase: '/exports',
    allowedKeys: CONSUMER_KEYS,
    owner: 'The workflow',
    kind: 'export',
    problems,
  })

  const steps = []
  const seenIds = new Set()
  for (let index = 0; index < spec.steps.length; index += 1) {
    const step = normalizeStep(spec.steps[index], index, seenIds, limits, problems)
    if (step === null) continue
    seenIds.add(step.id)
    steps.push(step)
  }
  steps.sort((left, right) => byCodeUnit(left.id, right.id))

  return { stopped: false, problems, workflow, declaredSteps: spec.steps.length, steps, provided, exports: exported }
}

function normalizeStep(raw, index, seenIds, limits, problems) {
  const at = `/steps/${index}`
  if (!isRecord(raw)) {
    problems.push(problem('step-malformed', at, `Step at index ${index} is ${describe(raw)} rather than an object.`))
    return null
  }
  for (const key of Object.keys(raw)) {
    if (!STEP_KEYS.includes(key)) {
      problems.push(problem(
        'unknown-declaration-key',
        at,
        `Step at index ${index} declares an unknown key "${sanitize(key, NAME_LIMIT)}"; its intent could not be read.`,
        { suggestion: `Remove it or correct the spelling. Allowed keys: ${STEP_KEYS.join(', ')}.` },
      ))
    }
  }
  if (typeof raw.id !== 'string' || raw.id.length > NAME_LIMIT || !NAME_PATTERN.test(raw.id)) {
    problems.push(problem(
      'step-id-invalid',
      at,
      `Step at index ${index} has no usable id, so nothing can depend on it and it was not analysed.`,
      { evidence: typeof raw.id === 'string' ? raw.id : describe(raw.id) },
    ))
    return null
  }
  const id = raw.id
  const stepPointer = `/steps/${id}`
  if (seenIds.has(id)) {
    problems.push(problem(
      'step-id-duplicated',
      stepPointer,
      `Step id "${sanitize(id, NAME_LIMIT)}" is declared more than once, so which declaration a dependency names is unknown; the later one was not analysed.`,
    ))
    return null
  }

  const version = parseVersion(raw.version)
  if (version === null) {
    problems.push(problem(
      'step-version-invalid',
      `${stepPointer}/version`,
      `Step "${sanitize(id, NAME_LIMIT)}" declares no readable major.minor.patch version, so version constraints against it could not be checked.`,
      { evidence: typeof raw.version === 'string' ? raw.version : describe(raw.version) },
    ))
  }

  const rawInputs = readListForStep(raw.inputs, 'inputs', `${stepPointer}/inputs`, id, problems)
  const rawOutputs = readListForStep(raw.outputs, 'outputs', `${stepPointer}/outputs`, id, problems)
  if (rawInputs.length + rawOutputs.length > limits.maxPortsPerStep) {
    problems.push(problem(
      'too-many-ports',
      stepPointer,
      `Step "${sanitize(id, NAME_LIMIT)}" declares ${rawInputs.length + rawOutputs.length} ports, over the maxPortsPerStep budget of ${limits.maxPortsPerStep}; the step was not analysed.`,
      { suggestion: 'Raise --max-ports-per-step deliberately, or split the step.' },
    ))
    return null
  }

  const owner = `Step "${sanitize(id, NAME_LIMIT)}"`
  const inputs = normalizePortList(rawInputs, {
    pointerBase: `${stepPointer}/inputs`,
    allowedKeys: CONSUMER_KEYS,
    owner,
    kind: 'input',
    problems,
  })
  const outputs = normalizePortList(rawOutputs, {
    pointerBase: `${stepPointer}/outputs`,
    allowedKeys: PRODUCER_KEYS,
    owner,
    kind: 'output',
    problems,
  })

  const requires = normalizeRequires(raw.requires, id, stepPointer, limits, problems)
  if (requires === null) return null

  return { id, index, pointer: stepPointer, version, declaredVersion: raw.version, inputs, outputs, requires }
}

function readListForStep(raw, name, pointer, id, problems) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problems.push(problem('step-malformed', pointer, `Step "${sanitize(id, NAME_LIMIT)}" declares "${name}" as ${describe(raw)} rather than an array.`))
    return []
  }
  return raw
}

function normalizeRequires(raw, id, stepPointer, limits, problems) {
  if (raw === undefined) return []
  const at = `${stepPointer}/requires`
  if (!Array.isArray(raw)) {
    problems.push(problem('dependency-malformed', at, `Step "${sanitize(id, NAME_LIMIT)}" declares "requires" as ${describe(raw)} rather than an array.`))
    return []
  }
  if (raw.length > limits.maxDependenciesPerStep) {
    problems.push(problem(
      'too-many-dependencies',
      at,
      `Step "${sanitize(id, NAME_LIMIT)}" declares ${raw.length} dependencies, over the maxDependenciesPerStep budget of ${limits.maxDependenciesPerStep}; the step was not analysed.`,
      { suggestion: 'Raise --max-dependencies-per-step deliberately, or split the step.' },
    ))
    return null
  }
  const requires = []
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index]
    if (typeof entry !== 'string' || entry.length > NAME_LIMIT || !NAME_PATTERN.test(entry)) {
      problems.push(problem(
        'dependency-malformed',
        `${at}/${index}`,
        `Step "${sanitize(id, NAME_LIMIT)}" declares a dependency that is not a step id.`,
        { evidence: typeof entry === 'string' ? entry : describe(entry) },
      ))
      continue
    }
    if (!requires.includes(entry)) requires.push(entry)
  }
  return requires
}
