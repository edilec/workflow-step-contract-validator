# The specification, the rules, the limits and the contract

This tool reads one JSON document, decides whether the steps it declares can be
wired together at all, and derives a typed execution contract from the answer.
It never executes a step, never fetches anything, and writes nothing except the
contract file the caller explicitly asks for.

## The specification document

```json
{
  "schemaVersion": "1",
  "workflow": "order-fulfilment",
  "provided": [{ "name": "orderId", "type": "string" }],
  "exports": [{ "name": "shipment", "type": "Shipment" }],
  "steps": [
    {
      "id": "fetch-order",
      "version": "2.1.0",
      "requires": ["authorise"],
      "inputs": [{ "name": "orderId", "type": "string", "minVersion": "1.0.0", "optional": false }],
      "outputs": [{ "name": "order", "type": "Order", "optional": false }]
    }
  ]
}
```

| Where | Keys |
| --- | --- |
| document | `schemaVersion` (must be `"1"`), `workflow`, `description`, `provided`, `exports`, `steps` |
| step | `id`, `version`, `description`, `requires`, `inputs`, `outputs` |
| input / export | `name`, `type`, `optional`, `minVersion`, `description` |
| output / provided | `name`, `type`, `optional`, `description` |

Any other key is reported as `unknown-declaration-key` and makes the run
incomplete. A key that is silently ignored is how `"optionl": true` turns a
declaration into its opposite without anyone noticing.

`description` is accepted everywhere and is never echoed into a report.

### Identifiers, types and versions

- A step id and a channel name match `^[A-Za-z][A-Za-z0-9_.-]*$` and are at most
  100 characters. An identifier that does not match is reported, never repaired:
  renaming a declaration would change which channel it binds to.
- A type name matches `^[A-Za-z][A-Za-z0-9_.:-]*(\[\])?$`, so `Order`,
  `order.v2`, `acme:Order` and `Order[]` are all type names.
- A version is exactly `major.minor.patch`. A pre-release, build metadata or a
  two-part version is refused as unreadable rather than guessed at.

### Channels

A channel is named by a string. One producer declares it -- a step output, or an
entry under `provided` -- and any number of consumers name it: step inputs, and
the workflow's own `exports`. Binding is by name; there is no renaming, aliasing
or positional matching.

`(provided)` and `(workflow)` name the two participants that are not steps. They
cannot collide with a step id, which must begin with a letter.

## Compatibility

A consumer and its producer are compatible when all three hold:

1. **A producer exists.** Otherwise `missing-producer`.
2. **The type names are equal.** Comparison is exact and case-sensitive:
   `type-incompatible` is raised for `string` against `String`. This tool has no
   structural subtyping and never decides that two differently named types mean
   the same thing.
3. **Optionality is satisfied.** This is the asymmetric one:

   | Producer | Consumer | Verdict |
   | --- | --- | --- |
   | required | required | compatible |
   | required | optional | compatible |
   | optional | optional | compatible |
   | optional | required | `optional-output-required-input` |

   A consumer that requires a value the producer may not emit fails on exactly
   the branch where the producer stays silent, which is the branch nobody tests.

A consumer may additionally declare `minVersion`, which is checked against the
**producing step's** version by two rules: the major version must match
(`producer-major-mismatch` otherwise) and the rest must be at least the minimum
(`producer-version-too-low` otherwise). This is not npm's `^`, which treats a
`0.x` major as unstable and admits only `0.1.x` for `^0.1.0`; here a `0.9.0`
producer satisfies a `0.1.0` minimum, because in this document the major version
carries the whole of the compatibility claim. A constraint that could not be checked --
because the channel is supplied to the workflow, or the producing step's version
could not be read -- is `producer-version-unknown`, which is unknown evidence and
makes the run incomplete. It is never treated as satisfied.

## Scheduling

Dependencies come from two places: a resolved binding (a step depends on the step
that produces what it consumes) and an explicit `requires` entry. The order is
resolved by Kahn's algorithm, so a stage is the set of steps that become ready in
the same round -- the parallelism a scheduler could use. Steps within a stage are
listed in code-unit order.

Steps left unscheduled are in a cycle (`dependency-cycle`, one finding per cycle,
written from the cycle's code-unit-smallest member) or behind one
(`step-unschedulable`). A step that depends on itself is a cycle of one.

## Rule catalog

`incomplete` marks the rules that mean a question could not be answered. Every
one of them makes the whole run `incomplete`, whatever its severity, and an
incomplete run is never a pass.

| Rule | Severity | Incomplete | Meaning |
| --- | --- | --- | --- |
| `dependency-cycle` | error | no | Steps depend on each other in a cycle, so none of them can be scheduled. |
| `dependency-malformed` | error | yes | A `requires` list, or an entry in one, is not a step id. |
| `duplicate-producer` | error | no | Two producers declare the same channel, so which value a consumer receives is undefined. |
| `graph-budget-exceeded` | error | yes | Resolving the graph would have exceeded `maxGraphOperations`. |
| `graph-too-deep` | error | yes | The graph has more stages, or the cycle search more levels, than `maxDepth`. |
| `missing-producer` | error | no | A consumer names a channel no step produces and the workflow does not provide. |
| `no-steps-declared` | warning | yes | The document declares no steps, so the run checked nothing. |
| `optional-output-required-input` | error | no | A required consumer is bound to an output the producer only optionally emits. |
| `output-unconsumed` | info | no | A step output nothing consumes and the workflow does not export. |
| `port-duplicated` | error | yes | A step declares the same input or output name twice. |
| `port-malformed` | error | yes | A port is not an object, or one of its fields has the wrong shape. |
| `port-name-invalid` | error | yes | A port name is missing or is not an identifier, so it binds to no channel. |
| `port-type-invalid` | error | yes | A port has no readable type, so its compatibility could not be decided. |
| `producer-major-mismatch` | error | no | The producing step's major version is not the one the consumer requires. |
| `producer-version-too-low` | error | no | The producing step is older than the consumer's `minVersion`. |
| `producer-version-unknown` | warning | yes | A `minVersion` constraint could not be checked against any known version. |
| `provided-unused` | info | no | A provided channel nothing consumes and the workflow does not export. |
| `spec-malformed` | error | yes | The document is not a usable specification, or a field of it is not. |
| `spec-not-json` | error | yes | The document is not valid JSON. |
| `spec-not-utf8` | error | yes | The document is not valid UTF-8. |
| `spec-too-large` | error | yes | The document is larger than `maxBytes` and was not read. |
| `spec-unreadable` | error | yes | The document could not be read from disk. |
| `step-id-duplicated` | error | yes | Two steps declare the same id, so which one a dependency names is unknown. |
| `step-id-invalid` | error | yes | A step has no usable id, so nothing can depend on it. |
| `step-malformed` | error | yes | A step is not an object, or its `inputs` or `outputs` is not an array. |
| `step-unschedulable` | error | no | A step waits, directly or indirectly, behind a dependency cycle. |
| `step-version-invalid` | error | yes | A step declares no readable `major.minor.patch` version. |
| `time-budget-exceeded` | error | yes | Validation ran past `maxMillis` before it finished. |
| `too-many-dependencies` | error | yes | A step declares more `requires` entries than `maxDependenciesPerStep`. |
| `too-many-exports` | error | yes | The document declares more exports than `maxExports`. |
| `too-many-ports` | error | yes | A step declares more inputs plus outputs than `maxPortsPerStep`. |
| `too-many-provided` | error | yes | The document declares more provided channels than `maxProvided`. |
| `too-many-steps` | error | yes | The document declares more steps than `maxSteps`. |
| `type-incompatible` | error | no | A consumer's declared type is not the producer's declared type. |
| `unknown-declaration-key` | error | yes | A declaration carries a key this tool does not know, so its intent could not be read. |
| `unknown-dependency` | error | no | A `requires` entry names a step the document does not declare. |

Rule ids are part of the public interface. Renaming or removing one is a
breaking change and is recorded in the changelog.

## Limits

| Limit | Flag | Default | What it bounds |
| --- | --- | ---: | --- |
| `maxBytes` | `--max-bytes` | 1048576 | Specification size, checked before decoding |
| `maxSteps` | `--max-steps` | 500 | Declared steps |
| `maxPortsPerStep` | `--max-ports-per-step` | 64 | Inputs plus outputs on one step |
| `maxDependenciesPerStep` | `--max-dependencies-per-step` | 64 | `requires` entries on one step |
| `maxProvided` | `--max-provided` | 200 | Provided channels |
| `maxExports` | `--max-exports` | 200 | Exports |
| `maxDepth` | `--max-depth` | 64 | Execution stages, and cycle-search depth |
| `maxGraphOperations` | `--max-graph-operations` | 200000 | Edge relaxations and traversal steps |
| `maxMillis` | `--max-millis` | 5000 | Validation time budget |

A limit that is reached is reported by name and makes the run incomplete.
Nothing is truncated: a document-level limit refuses the **document**, and a
step-level limit refuses the **step**. Analysing the first 500 of 900 steps would
report a missing producer for every binding into the 400 that were dropped, which
is a fabricated verdict.

`maxMillis` is the only limit that may be zero. A budget of zero is spent before
any work is done, which is how the test suite proves the command line wires a
clock through at all, rather than accepting a flag it never reads.

Every other limit must be a positive integer, and an unknown limit name is a
configuration error. A one-character typo must not leave a default quietly in
force.

## The execution contract

`--contract FILE` writes the derived contract:

```json
{
  "schemaVersion": "1",
  "tool": "workflow-step-contract-validator",
  "workflow": "order-fulfilment",
  "status": "pass",
  "complete": true,
  "counts": { "steps": 5, "checked": 5, "channels": 8, "bindings": 9, "unbound": 0, "resolved": 5, "unresolved": 0, "cycles": 0 },
  "order": [{ "stage": 0, "steps": ["fetch-order"] }],
  "unresolved": [],
  "steps": [{ "id": "ship", "version": "1.2.0", "stage": 3, "consumes": [], "produces": [] }],
  "exports": [{ "name": "shipment", "type": "Shipment", "optional": false, "minVersion": null, "from": "ship", "resolved": true }],
  "channels": [{ "name": "order", "type": "Order", "optional": false, "producer": "fetch-order", "producers": 1, "consumers": ["check-stock"] }]
}
```

A binding that resolved to no producer is listed with `"resolved": false` rather
than omitted: a contract that quietly dropped it would read as if the step had
one fewer requirement than it declared. `complete` is false whenever the status
is `incomplete`, so a consumer never has to infer it.

A path is not the file it names. Three indirections turn the destination you
typed into a different file, they are independent, and each needs its own check:

| Hole | Why the obvious guard misses it |
| --- | --- |
| A **symbolic link at the destination** | `realpath` on the destination *resolves* the link, and resolving is the dangerous act. It is refused on sight with `lstat`, before anything is opened -- which also covers a link aimed at a path that does not exist yet, where following it creates a file the caller never named. |
| A **symbolically linked parent** | A lexical prefix test passes for `root/link/out` where `link` leaves the root. The parent is resolved first and compared afterwards. |
| A **hard link to an input** | It has no target to resolve and shares no path with the input, so `realpath` and string comparison both call it a different file. It is the same file. Only device plus inode sees that. Hard links are routine in build trees -- `cp -l`, package-store linking, de-duplicating backups. |

A destination that exists and is not a regular file -- a directory, a socket --
is refused as well. Every refusal is a configuration error: exit 2, empty
stdout, nothing written, and it happens before the specification is read.

What is **not** refused matters as much, because a guard that refuses
everything is a guard nobody can use. The parent's nearest existing ancestor is
resolved and the segments that do not exist yet are appended, so a destination
whose directories this run will create is written as asked; and a directory
reached through a symbolic link is legitimate as long as it stays inside the
permitted tree -- the system temporary directory on macOS is itself a link, and
refusing that would refuse every run in it.

## Determinism

Running the tool twice over the same specification produces byte-identical
stdout and a byte-identical contract.

- Findings are ordered by `(location.pointer, ruleId, message)`, by code unit,
  with declaration order as the final tiebreak. `location.file` is not part of
  the key: a run has one document, so ordering by it would compare a string with
  itself.
- Steps, channels and stage members are ordered by code unit.
- Nothing is ordered by `localeCompare` or `Intl.Collator`. Collation depends on
  ICU data that differs between Node builds, and it has already produced a real
  ordering difference in this catalog.
- No clock reading, absolute path, host name or random value reaches the output.
  The time budget is measured with a monotonic counter whose value is never
  reported; the only thing it can change is whether the budget was spent.
- Declaration order and JSON key order do not reach the output.

## Output sanitising

Every string that came out of the specification is sanitised before it reaches
the report, the contract or the human summary: step ids, channel names, type
names, versions, unknown key names, the workflow label and the source label --
not only an excerpt field. The removed classes are:

| Class | Range |
| --- | --- |
| C0 | `U+0000`-`U+001F` |
| DEL | `U+007F` |
| C1 | `U+0080`-`U+009F` |
| Line and paragraph separators | `U+2028`, `U+2029` |
| Bidi controls | `U+200E`, `U+200F`, `U+202A`-`U+202E`, `U+2066`-`U+2069` |

`U+0085` (NEL) and `U+009B` (the 8-bit CSI) forge a line in a human report
exactly as a newline does, and neither is escaped by `JSON.stringify`. `U+202E`
reverses the text displayed after it, so a step named one thing is read as
another.

Sanitising is not enough for one string, so `spec-not-json` reports a parse
failure by position rather than by quotation. `JSON.parse` has two error
messages and one of them embeds the input --
`Unexpected token 'A', "AKIA..." is not valid JSON` for a short document, and a
ten-character window around the offending character for a long one. A
specification short enough to be only a credential would otherwise be
reproduced in full by the evidence of the finding that says nothing was read,
and sanitising does not remove it: the quoted span is at the front of the
message while the bound cuts from the back. `parseFailureDetail` keeps the
position, line and column -- which carry no input -- and drops the quotation.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | Every step contract checked out | the report |
| 1 | The workflow is unschedulable or incompatible as declared | the report |
| 2 | Invalid usage or configuration | **empty** |
| 2 | Evidence missing, unreadable or bounded out (`incomplete`) | the report |

A configuration error means the run never had a subject, so there is nothing to
report about. An unreadable input means the run had a subject and failed to
obtain evidence about it, and a consumer needs the report to know which input was
not read.
