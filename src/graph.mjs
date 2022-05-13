/**
 * Static resolution of the dependency graph.
 *
 * Nothing here executes a step. The graph answers two questions: in what order
 * could these steps run, and which of them could never run because they sit in
 * or behind a cycle.
 *
 * Two properties are structural:
 *
 * 1. **The order is deterministic.** Steps that become ready in the same round
 *    are emitted in code-unit order, so the resolved contract does not depend
 *    on declaration order, on object key order, or on a collation table.
 * 2. **Every walk is bounded.** The stage count, the traversal depth and the
 *    number of edge relaxations all have explicit budgets, and exceeding one
 *    stops the walk with a named problem rather than truncating the answer.
 */

import { byCodeUnit } from './text.mjs'

function problem(ruleId, message, suggestion) {
  return { ruleId, message, suggestion }
}

/**
 * Resolve stages by Kahn's algorithm, then name the cycles in what is left.
 *
 * `dependencies` maps a step id to the ids it depends on; an edge points from
 * a dependent back to what it waits for. A step is ready when everything it
 * waits for has been scheduled, and a stage is the set of steps ready at the
 * same time -- which is exactly the parallelism a scheduler could use.
 */
export function resolveExecutionOrder(nodeIds, dependencies, options) {
  const { maxDepth, maxGraphOperations, deadline } = options
  const ids = [...nodeIds].sort(byCodeUnit)
  const deps = new Map(ids.map((id) => [id, [...new Set(dependencies.get(id) ?? [])].sort(byCodeUnit)]))
  const problems = []
  let operations = 0

  const spend = () => {
    operations += 1
    return operations <= maxGraphOperations
  }
  const exhausted = () => problem(
    'graph-budget-exceeded',
    `Resolving the dependency graph would have exceeded the maxGraphOperations budget of ${maxGraphOperations}; the execution order was not resolved.`,
    'Raise --max-graph-operations deliberately, or reduce the number of dependency edges.',
  )
  const expired = () => problem(
    'time-budget-exceeded',
    `Resolving the dependency graph exceeded the maxMillis budget; the execution order was not resolved.`,
    'Raise --max-millis deliberately, or reduce the size of the workflow.',
  )

  const dependents = new Map(ids.map((id) => [id, []]))
  for (const id of ids) {
    for (const dependency of deps.get(id)) {
      if (!spend()) return stopped(ids, [exhausted()])
      dependents.get(dependency).push(id)
    }
  }

  const indegree = new Map(ids.map((id) => [id, deps.get(id).length]))
  const order = []
  const stages = []
  let ready = ids.filter((id) => indegree.get(id) === 0)

  while (ready.length > 0) {
    if (stages.length >= maxDepth) {
      return stopped(ids, [problem(
        'graph-too-deep',
        `The dependency graph is more than ${maxDepth} stages deep, over the maxDepth budget; the execution order was not resolved.`,
        'Raise --max-depth deliberately, or shorten the longest dependency chain.',
      )])
    }
    if (deadline.exceeded()) return stopped(ids, [expired()])
    const stage = stages.length
    const next = []
    for (const id of ready) {
      order.push({ id, stage })
      for (const dependent of dependents.get(id)) {
        if (!spend()) return stopped(ids, [exhausted()])
        const remaining = indegree.get(dependent) - 1
        indegree.set(dependent, remaining)
        if (remaining === 0) next.push(dependent)
      }
    }
    stages.push([...ready])
    next.sort(byCodeUnit)
    ready = next
  }

  const scheduled = new Set(order.map((entry) => entry.id))
  const unresolved = ids.filter((id) => !scheduled.has(id))
  if (unresolved.length === 0) {
    return { stopped: false, order, stages, unresolved, cycles: [], unschedulable: [], problems }
  }

  const found = findCycles(unresolved, deps, { maxDepth, spend, deadline })
  if (found.problem !== null) problems.push(found.problem)
  const inCycle = new Set(found.cycles.flat())
  const unschedulable = unresolved.filter((id) => !inCycle.has(id))
  return { stopped: found.problem !== null, order, stages, unresolved, cycles: found.cycles, unschedulable, problems }

  function stopped(allIds, raised) {
    return { stopped: true, order: [], stages: [], unresolved: [...allIds], cycles: [], unschedulable: [], problems: raised }
  }
}

/**
 * Name the cycles among the steps Kahn's algorithm could not schedule.
 *
 * The walk is iterative with an explicit stack, so a deep graph cannot exhaust
 * the JavaScript call stack, and both the depth and the number of steps taken
 * are bounded. Roots and successors are visited in code-unit order, so the
 * same graph always yields the same cycle, written from the same starting
 * point: each cycle is rotated to begin at its code-unit-smallest member.
 */
export function findCycles(candidates, deps, options) {
  const { maxDepth, spend, deadline } = options
  const present = new Set(candidates)
  const colour = new Map(candidates.map((id) => [id, 'unvisited']))
  const cycles = []
  const seen = new Set()

  for (const root of candidates) {
    if (colour.get(root) !== 'unvisited') continue
    const path = [root]
    const stack = [{ id: root, next: 0 }]
    colour.set(root, 'open')

    while (stack.length > 0) {
      if (!spend()) {
        return {
          cycles,
          problem: problem(
            'graph-budget-exceeded',
            'Searching for dependency cycles would have exceeded the maxGraphOperations budget; some cycles may not be named.',
            'Raise --max-graph-operations deliberately, or reduce the number of dependency edges.',
          ),
        }
      }
      if (deadline.exceeded()) {
        return {
          cycles,
          problem: problem(
            'time-budget-exceeded',
            'Searching for dependency cycles exceeded the maxMillis budget; some cycles may not be named.',
            'Raise --max-millis deliberately, or reduce the size of the workflow.',
          ),
        }
      }
      const frame = stack[stack.length - 1]
      const successors = deps.get(frame.id).filter((id) => present.has(id))
      if (frame.next >= successors.length) {
        colour.set(frame.id, 'closed')
        stack.pop()
        path.pop()
        continue
      }
      const successor = successors[frame.next]
      frame.next += 1
      if (colour.get(successor) === 'open') {
        const cycle = rotate(path.slice(path.indexOf(successor)))
        const key = cycle.join(' -> ')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push(cycle)
        }
        continue
      }
      if (colour.get(successor) !== 'unvisited') continue
      if (stack.length >= maxDepth) {
        return {
          cycles,
          problem: problem(
            'graph-too-deep',
            `Searching for dependency cycles reached ${maxDepth} levels, the maxDepth budget; some cycles may not be named.`,
            'Raise --max-depth deliberately, or shorten the longest dependency chain.',
          ),
        }
      }
      colour.set(successor, 'open')
      path.push(successor)
      stack.push({ id: successor, next: 0 })
    }
  }
  return { cycles, problem: null }
}

/** Rotate a cycle so that it starts at its code-unit-smallest member. */
function rotate(cycle) {
  let pivot = 0
  for (let index = 1; index < cycle.length; index += 1) {
    if (byCodeUnit(cycle[index], cycle[pivot]) < 0) pivot = index
  }
  return [...cycle.slice(pivot), ...cycle.slice(0, pivot)]
}
