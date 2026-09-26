import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeWorkflow, validateWorkflowFile } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(spec) {
  return analyzeWorkflow({ bytes: new TextEncoder().encode(JSON.stringify(spec)) })
}

test('the contract states the resolved order and where every value comes from', async () => {
  const { report, contract } = await validateWorkflowFile(join(projectDirectory, 'examples', 'order-fulfilment.json'), {
    source: 'examples/order-fulfilment.json',
  })
  assert.equal(report.status, 'pass')
  assert.equal(contract.schemaVersion, '1')
  assert.equal(contract.tool, 'workflow-step-contract-validator')
  assert.equal(contract.workflow, 'order-fulfilment')
  assert.equal(contract.complete, true)
  assert.deepEqual(contract.order, [
    { stage: 0, steps: ['fetch-order'] },
    { stage: 1, steps: ['check-stock', 'price-order'] },
    { stage: 2, steps: ['notify-backorder'] },
    { stage: 3, steps: ['ship'] },
  ])
  assert.deepEqual(contract.unresolved, [])

  const ship = contract.steps.find((entry) => entry.id === 'ship')
  assert.equal(ship.stage, 3)
  assert.equal(ship.version, '1.2.0')
  assert.deepEqual(ship.consumes, [
    { name: 'reservation', type: 'Reservation', optional: false, minVersion: null, from: 'check-stock', resolved: true },
    { name: 'invoice', type: 'Invoice', optional: false, minVersion: null, from: 'price-order', resolved: true },
  ])
  assert.deepEqual(ship.produces, [{ name: 'shipment', type: 'Shipment', optional: false }])

  const backorder = contract.channels.find((channel) => channel.name === 'backorder')
  assert.deepEqual(backorder, {
    name: 'backorder',
    type: 'Backorder',
    optional: true,
    producer: 'check-stock',
    producers: 1,
    consumers: ['notify-backorder'],
  })

  assert.deepEqual(contract.exports, [
    { name: 'shipment', type: 'Shipment', optional: false, minVersion: null, from: 'ship', resolved: true },
    { name: 'notice', type: 'Notice', optional: false, minVersion: null, from: 'notify-backorder', resolved: true },
  ])
  // A channel supplied to the workflow is a producer like any other, and the
  // step that consumes it is recorded as its consumer.
  const seed = contract.channels.find((channel) => channel.name === 'orderId')
  assert.equal(seed.producer, '(provided)')
  assert.deepEqual(seed.consumers, ['fetch-order'])
})

test('the contract never carries a host path', async () => {
  const { contract } = await validateWorkflowFile(join(projectDirectory, 'examples', 'order-fulfilment.json'), {
    source: 'examples/order-fulfilment.json',
  })
  const serialised = JSON.stringify(contract)
  assert.equal(serialised.includes(projectDirectory), false, 'the contract carries an absolute host path')
  assert.equal(contract.source, 'examples/order-fulfilment.json')
})

test('an incomplete run says so in the contract as well as the report', () => {
  const { report, contract } = run({ schemaVersion: '1', steps: [{ id: 'a', version: 'one' }] })
  assert.equal(report.status, 'incomplete')
  assert.equal(contract.status, 'incomplete')
  assert.equal(contract.complete, false, 'an incomplete run produced a contract that claims to be complete')
  assert.equal(contract.steps[0].version, null)
})

test('a channel with no producer is listed as unresolved rather than omitted', () => {
  const { contract } = run({
    schemaVersion: '1',
    exports: [{ name: 'missing', type: 'string' }],
    steps: [{ id: 'a', version: '1.0.0', inputs: [{ name: 'ghost', type: 'string' }] }],
  })
  assert.deepEqual(contract.steps[0].consumes, [
    { name: 'ghost', type: 'string', optional: false, minVersion: null, from: null, resolved: false },
  ])
  assert.deepEqual(contract.exports, [
    { name: 'missing', type: 'string', optional: false, minVersion: null, from: null, resolved: false },
  ])
  assert.equal(contract.counts.unbound, 2)
})

test('the counts in the contract are the counts in the report', () => {
  const { report, contract } = run({
    schemaVersion: '1',
    provided: [{ name: 'seed', type: 'string' }],
    steps: [
      { id: 'a', version: '1.0.0', inputs: [{ name: 'seed', type: 'string' }], outputs: [{ name: 'x', type: 'string' }] },
      { id: 'b', version: '1.0.0', inputs: [{ name: 'x', type: 'string' }] },
    ],
  })
  assert.deepEqual(contract.counts, {
    steps: report.summary.steps,
    checked: report.summary.checked,
    channels: report.summary.channels,
    bindings: report.summary.bindings,
    unbound: report.summary.unbound,
    resolved: report.summary.resolved,
    unresolved: report.summary.unresolved,
    cycles: report.summary.cycles,
  })
  assert.deepEqual(contract.counts, {
    steps: 2, checked: 2, channels: 2, bindings: 2, unbound: 0, resolved: 2, unresolved: 0, cycles: 0,
  })
})
