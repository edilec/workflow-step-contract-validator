import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit, decodeUtf8, fieldPath, sanitize } from '../src/text.mjs'

/**
 * The primitives every other guarantee rests on. These are unit tests of the
 * functions; the behavioural proof that the tool routes untrusted strings
 * through them lives in test/sanitising.test.mjs and test/ordering.test.mjs,
 * which assert what a run actually emits.
 *
 * Forbidden characters are written as code points rather than as literals: a
 * raw U+2028 in a source file is a hazard in its own right, and a reader can
 * check a number against the table in the contract.
 */

const CH = (code) => String.fromCharCode(code)
const REPLACEMENT = CH(0xfffd)

test('decoding is strict, and the decoded text never gets a vote', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x7b, 0x7d])), { ok: true, text: '{}' })
  assert.deepEqual(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x00])), { ok: false, reason: 'not-utf8' })
  // A document that legitimately contains U+FFFD decodes. Inferring "not UTF-8"
  // from a replacement character in the output is the defect this refuses.
  const legitimate = new TextEncoder().encode(`{"a":"${REPLACEMENT}"}`)
  assert.equal(decodeUtf8(legitimate).ok, true)
  assert.equal(decodeUtf8(legitimate).text, `{"a":"${REPLACEMENT}"}`)
})

test('every forbidden class is removed, not only C0', () => {
  const cases = [
    ['C0 BEL U+0007', 0x07],
    ['C0 LF U+000A', 0x0a],
    ['C0 US U+001F', 0x1f],
    ['DEL U+007F', 0x7f],
    ['C1 NEL U+0085', 0x85],
    ['C1 CSI U+009B', 0x9b],
    ['line separator U+2028', 0x2028],
    ['paragraph separator U+2029', 0x2029],
    ['LRM U+200E', 0x200e],
    ['RLM U+200F', 0x200f],
    ['LRE U+202A', 0x202a],
    ['RLO U+202E', 0x202e],
    ['isolate U+2066', 0x2066],
    ['pop isolate U+2069', 0x2069],
  ]
  for (const [name, code] of cases) {
    assert.equal(sanitize(`a${CH(code)}b`), 'a b', `${name} survived sanitising`)
  }
})

test('sanitising bounds what one string contributes', () => {
  assert.equal(sanitize('x'.repeat(10), 4), 'xxxx...')
  assert.equal(sanitize('   spaced   out  '), 'spaced out')
  assert.throws(() => sanitize('x', 0), TypeError)
  assert.throws(() => sanitize('x', 1.5), TypeError)
})

test('ordering is by code unit, where collation genuinely disagrees', () => {
  // A collator folds case and treats punctuation as ignorable, so it orders
  // each of these pairs the other way round. Code units do not.
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('b', 'a') > 0, true)
})

test('field paths escape their segments after sanitising them', () => {
  assert.equal(fieldPath('steps', 'a/b'), '/steps/a~1b')
  assert.equal(fieldPath('steps', 'a~b'), '/steps/a~0b')
  // Sanitising happens first: escaping first would carry the control character
  // through the escape and into the pointer.
  assert.equal(fieldPath('steps', `a${CH(0x85)}/b`), '/steps/a ~1b')
})
