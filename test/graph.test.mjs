import assert from 'node:assert/strict'
import test from 'node:test'

import { findCycles, resolveExecutionOrder } from '../src/graph.mjs'

const never = { exceeded: () => false }
const always = { exceeded: () => true }
const graph = (entries) => new Map(Object.entries(entries))
const wide = { maxDepth: 64, maxGraphOperations: 10000, deadline: never }

test('stages are the parallelism a scheduler could use', () => {
  const result = resolveExecutionOrder(['a', 'b', 'c', 'd'], graph({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] }), wide)
  assert.equal(result.stopped, false)
  assert.deepEqual(result.stages, [['a'], ['b', 'c'], ['d']])
  assert.deepEqual(result.order, [
    { id: 'a', stage: 0 },
    { id: 'b', stage: 1 },
    { id: 'c', stage: 1 },
    { id: 'd', stage: 2 },
  ])
  assert.deepEqual(result.unresolved, [])
  assert.deepEqual(result.cycles, [])
})

test('a stage is emitted in code-unit order, whatever order the nodes arrived in', () => {
  // Declaration order here is the reverse of the answer, and a collator would
  // order these 'assets', 'README', 'Z'. Only code units give this sequence.
  const ids = ['assets', 'Z', 'README']
  const result = resolveExecutionOrder(ids, graph({ assets: [], Z: [], README: [] }), wide)
  assert.deepEqual(result.stages, [['README', 'Z', 'assets']])
})

test('a cycle is named from its code-unit-smallest member, however it is entered', () => {
  const result = resolveExecutionOrder(['x', 'y', 'z'], graph({ x: ['z'], y: ['x'], z: ['y'] }), wide)
  assert.deepEqual(result.order, [])
  assert.deepEqual(result.unresolved, ['x', 'y', 'z'])
  assert.deepEqual(result.cycles, [['x', 'z', 'y']])
  assert.deepEqual(result.unschedulable, [])
})

test('a step behind a cycle is unschedulable but is not part of it', () => {
  const result = resolveExecutionOrder(['a', 'b', 'c'], graph({ a: ['b'], b: ['c'], c: ['b'] }), wide)
  assert.deepEqual(result.cycles, [['b', 'c']])
  assert.deepEqual(result.unschedulable, ['a'])
  assert.deepEqual(result.unresolved, ['a', 'b', 'c'])
})

test('a step that depends on itself is a cycle of one', () => {
  const result = resolveExecutionOrder(['a'], graph({ a: ['a'] }), wide)
  assert.deepEqual(result.cycles, [['a']])
  assert.deepEqual(result.order, [])
})

test('every budget stops the walk with a named problem rather than an answer', () => {
  const deep = resolveExecutionOrder(['a', 'b'], graph({ a: [], b: ['a'] }), { ...wide, maxDepth: 1 })
  assert.equal(deep.stopped, true)
  assert.deepEqual(deep.order, [], 'a partial order was returned for a graph that was not resolved')
  assert.deepEqual(deep.problems.map((problem) => problem.ruleId), ['graph-too-deep'])

  const budget = resolveExecutionOrder(['a', 'b', 'c'], graph({ a: [], b: ['a'], c: ['b'] }), { ...wide, maxGraphOperations: 1 })
  assert.equal(budget.stopped, true)
  assert.deepEqual(budget.problems.map((problem) => problem.ruleId), ['graph-budget-exceeded'])

  const timed = resolveExecutionOrder(['a'], graph({ a: [] }), { ...wide, deadline: always })
  assert.equal(timed.stopped, true)
  assert.deepEqual(timed.problems.map((problem) => problem.ruleId), ['time-budget-exceeded'])
})

test('cycle search is bounded too, and says so rather than answering', () => {
  const deps = graph({ a: ['b'], b: ['a'] })
  const spent = findCycles(['a', 'b'], deps, { maxDepth: 64, spend: () => false, deadline: never })
  assert.equal(spent.problem.ruleId, 'graph-budget-exceeded')
  assert.deepEqual(spent.cycles, [])

  const shallow = findCycles(['a', 'b'], deps, { maxDepth: 1, spend: () => true, deadline: never })
  assert.equal(shallow.problem.ruleId, 'graph-too-deep')

  const late = findCycles(['a', 'b'], deps, { maxDepth: 64, spend: () => true, deadline: always })
  assert.equal(late.problem.ruleId, 'time-budget-exceeded')
})

test('the same cycle is named once however many nodes lead into it', () => {
  const result = resolveExecutionOrder(
    ['a', 'b', 'c', 'd'],
    graph({ a: ['c'], b: ['c'], c: ['d'], d: ['c'] }),
    wide,
  )
  assert.deepEqual(result.cycles, [['c', 'd']])
  assert.deepEqual(result.unschedulable, ['a', 'b'])
})
