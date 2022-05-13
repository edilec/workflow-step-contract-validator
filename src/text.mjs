/**
 * Decoding, ordering and sanitising primitives.
 *
 * Nothing here touches the filesystem, the clock, the locale, the environment
 * or the network. Every function is a pure function of its arguments, which is
 * what lets the same specification produce byte-identical output on any host.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both depend on ICU data that differs
 * between Node builds and platforms, and collation has already produced a real
 * ordering difference in this catalog. A resolved execution order is a
 * contract other tools read, so no part of it may depend on a collation table.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the point. Decoding leniently and then looking for U+FFFD
 * in the result cannot tell undecodable bytes apart from a document that
 * legitimately contains a replacement character, and that confusion has let an
 * unreadable input report a pass. The decoder decides; the decoded text never
 * gets a vote. This is used for the specification and for nothing else,
 * because the specification is the only untrusted byte stream this tool reads.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Characters removed before any specification-derived string reaches output.
 *
 * Built from code points rather than written literally: a literal U+2028 in a
 * module is a syntax hazard, and the whole point of the class is that these
 * characters never reach a report line. Each class forges or hides something
 * in an output a person reads:
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F): a bare newline forges a whole
 *   line in the human report; the rest drive a terminal.
 * - **C1** (U+0080-U+009F): U+0085 is NEL, which begins a new line on a
 *   terminal exactly as a newline does, and U+009B is the 8-bit CSI, which
 *   opens an escape sequence. Neither is ECMAScript whitespace and neither is
 *   escaped by `JSON.stringify`, so a class that stops at C0 lets both reach
 *   stdout intact.
 * - **U+2028 and U+2029**: they terminate a line for a JavaScript consumer.
 * - **Bidi controls** (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): U+202E
 *   reverses the text displayed after it, so a step called one thing is read
 *   as another; the isolates hide what they wrap.
 *
 * This applies to identifiers, keys, type names, versions and paths, not only
 * to an excerpt field. A step id, an unknown declaration key and a workflow
 * name all arrive from the same untrusted document as an excerpt does.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}${String.fromCharCode(12)}`
  + `${String.fromCharCode(14)}-${String.fromCharCode(31)}`
  + `${String.fromCharCode(127)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)

/** Bounds on what any one untrusted string may contribute to output. */
export const EXCERPT_LIMIT = 200
export const MESSAGE_LIMIT = 400
export const LABEL_LIMIT = 120
export const SEGMENT_LIMIT = 120

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every string that came out of the specification passes through here on its
 * way to the report, the contract or the human summary: step ids, port names,
 * type names, version strings, unknown key names, the workflow label and the
 * source label. Sanitising only an excerpt field has already let an identifier
 * carrying a newline forge extra lines in a human report.
 */
export function sanitize(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Sanitise limit must be a positive integer')
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/** Escape one path segment for a JSON Pointer, per RFC 6901. */
export function escapePointerSegment(segment) {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * Build a field path out of untrusted segments.
 *
 * The segments are step ids and port names taken from the document, so they
 * are sanitised first and escaped second: sanitising after escaping would let
 * a control character through the escape and into the pointer.
 */
export function fieldPath(...segments) {
  return `/${segments.map((segment) => escapePointerSegment(sanitize(segment, SEGMENT_LIMIT))).join('/')}`
}
