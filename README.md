# workflow-step-contract-validator

Validate a workflow DAG **statically**, before anything runs: every declared
input has a producer, the two sides of every binding agree on type, optionality
and version, and the dependency graph can actually be scheduled. The run
produces a typed execution contract naming the resolved order.

- **Repository:** [edilec/workflow-step-contract-validator](https://github.com/edilec/workflow-step-contract-validator)
- **Area:** Automation & Workflows
- **License:** MIT

Zero dependencies, runtime and development both. Node built-ins only, Node 22 or
newer.

## Why it exists

A workflow that fails half way through has already done half its work. Most of
the reasons are visible in the declarations alone: a step consuming a channel
nobody produces, two steps that disagree about a type, a step that requires a
value its producer only sometimes emits, or two steps waiting for each other.

The optional case is the one that gets past review. A producer that emits
`backorder` only when stock is short satisfies a consumer written to cope with
its absence, and fails a consumer that requires it -- on exactly the branch
nobody exercises in testing. This tool decides that asymmetry explicitly, in
both directions.

## Install

```sh
npm install workflow-step-contract-validator
```

Or run it without installing:

```sh
npx workflow-step-contract-validator --spec workflow.json
```

## Use

```sh
workflow-step-contract-validator --spec examples/order-fulfilment.json
```

```
workflow "order-fulfilment": 5 step(s) checked of 5 declared, 0 error, 0 warning, 0 info, status pass.
8 channel(s), 9 binding(s), 0 unbound, 5 step(s) ordered, 0 unresolved, 0 cycle(s).
order: [0] fetch-order | [1] check-stock, price-order | [2] notify-backorder | [3] ship
```

```sh
workflow-step-contract-validator --spec examples/broken-workflow.json
```

```
workflow "order-fulfilment (broken)": 6 step(s) checked of 6 declared, 7 error, 0 warning, 0 info, status fail.
7 channel(s), 9 binding(s), 1 unbound, 4 step(s) ordered, 2 unresolved, 1 cycle(s).
order: [0] fetch-order | [1] check-stock | [2] notify-backorder | [3] reprice
ERROR   examples/broken-workflow.json/steps/check-stock/inputs/catalogue missing-producer Step "check-stock" consumes channel "catalogue", which no step produces and the workflow does not provide.
ERROR   examples/broken-workflow.json/steps/check-stock/inputs/order producer-major-mismatch Step "check-stock" requires channel "order" from a 2.x producer, but fetch-order is version 1.9.0; a different major version is not compatible.
ERROR   examples/broken-workflow.json/steps/notify-backorder/inputs/backorder optional-output-required-input Step "notify-backorder" requires channel "backorder", but check-stock only optionally produces it, so the value can be absent when the step runs.
ERROR   examples/broken-workflow.json/steps/price-order dependency-cycle Steps form a dependency cycle: price-order -> ship -> price-order, where "X -> Y" means X depends on Y. None of them can be scheduled.
ERROR   examples/broken-workflow.json/steps/price-order/inputs/order type-incompatible Step "price-order" declares channel "order" as OrderRecord, but fetch-order produces it as Order.
ERROR   examples/broken-workflow.json/steps/reprice/outputs/invoice duplicate-producer Channel "invoice" is produced by reprice and by price-order, so which value a consumer receives is undefined.
ERROR   examples/broken-workflow.json/steps/ship/requires unknown-dependency Step "ship" requires "archive-order", which no step declares.
```

Add `--json` for the machine-readable report, and `--contract FILE` to write the
typed execution contract:

```sh
workflow-step-contract-validator --spec workflow.json --json --contract build/execution-contract.json
```

Every option is accepted once, an unknown option is refused rather than ignored,
and every documented limit has a flag. `--help` lists them all.

### Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | Every step contract checked out | the report |
| 1 | The workflow is unschedulable or incompatible as declared | the report |
| 2 | Invalid usage or configuration | **empty** |
| 2 | Evidence missing, unreadable or bounded out (`incomplete`) | the report |

A configuration error produces no report because the run never had a subject.
An input that could not be read produces one, with status `incomplete`, because
a consumer needs to know which input was not read. `incomplete` is never a pass.

## As a library

```js
import { analyzeWorkflow, validateWorkflowFile } from 'workflow-step-contract-validator'

const { report, contract } = await validateWorkflowFile('workflow.json', { source: 'workflow.json' })

if (report.status === 'pass') {
  for (const stage of contract.order) {
    console.log(`stage ${stage.stage}: ${stage.steps.join(', ')}`)
  }
}
```

`analyzeWorkflow({ bytes, source, limits, clock })` is the same analysis over
bytes you already hold. Both return `{ report, contract }`. A configuration
error -- an unknown option, an unknown limit, a limit that is not an integer --
throws; everything that is a fact about the document is a finding instead.

## What it checks

| Check | Rule |
| --- | --- |
| A consumed channel nobody produces | `missing-producer` |
| Producer and consumer declare different types | `type-incompatible` |
| A required consumer bound to an optional output | `optional-output-required-input` |
| Two producers of one channel | `duplicate-producer` |
| Steps waiting for each other | `dependency-cycle`, `step-unschedulable` |
| A dependency on a step that is not declared | `unknown-dependency` |
| A producer older than the consumer requires | `producer-version-too-low`, `producer-major-mismatch` |
| A declaration this tool could not read | 25 rules, every one of which makes the run `incomplete` |

The full catalog, with severities and limits, is in
[docs/contract-rules.md](./docs/contract-rules.md).

## Limits and non-goals

This tool reads declarations. It does not read the steps themselves, so there is
a great deal it cannot conclude:

- **It cannot tell you the workflow will work.** It checks what the
  specification says about the steps, not what the steps do. A step that
  declares an output and never emits it, emits it with the wrong shape, or
  crashes on its second input is invisible here.
- **It does not know what a type name means.** Compatibility is exact,
  case-sensitive name equality. `string` and `String` are different types;
  `Order` and `OrderRecord` are different types even if one is a subset of the
  other. There is no structural typing, no schema resolution and no subtyping,
  because guessing would mean reporting a compatibility that was never checked.
- **It does not resolve versions.** A version is exactly `major.minor.patch`. A
  `minVersion` constraint is satisfied when the producing step declares the same
  major version and is not older than the minimum -- which is deliberately not
  npm's `^`: `^0.1.0` admits only `0.1.x`, whereas here a `0.9.0` producer
  satisfies a `0.1.0` minimum, because the major version carries the whole of
  the compatibility claim. Pre-releases, build metadata and ranges are refused
  as unreadable rather than interpreted. It has no registry, and never fetches
  one.
- **It cannot see a dependency the document does not declare.** Two steps that
  share a database table, a lock or a file are independent as far as this tool
  is concerned. Declare the ordering with `requires` and it will be enforced;
  leave it out and nothing here will notice.
- **A resolved order is not a schedule.** Stages say what *could* run in
  parallel given the declared dependencies. They say nothing about cost,
  duration, retries, rate limits, concurrency budgets or failure handling.
- **It does not run, fetch, or write to the specification.** There is no
  execution, no network access and no auto-fix. The only file it writes is the
  contract destination you name -- and a path you name is not the file it names.
  A symbolic link at the destination is refused unresolved, because resolving it
  is what would write through it; so is a file this run reads, including one
  reached by a hard link, which shares no path with its input and is visible
  only as the same device and inode; so is a destination that exists and is not
  a regular file. Any of them is a configuration error: exit 2, nothing on
  stdout, nothing written. `--contract` is confined to no root, so a parent
  directory that is itself a symbolic link is followed and the contract lands
  wherever it leads: name a destination whose directories you control.
- **`pass` means "nothing was found", over the evidence that was obtained.**
  Whenever some evidence was not obtained, the status is `incomplete` and the
  exit code is 2. A workflow that declares no steps is `incomplete`, not `pass`:
  a green run on no evidence is worse than no run at all.

## Verification

```sh
npm run check
```

Runs the linter (`node --check` over every shipped file), the test suite, the
worked example and `npm pack --dry-run`.

The suite is built around one lesson from this catalog: a guarantee with no test
that fails when it is removed is a guarantee that will quietly stop being true.
So the guards assert behaviour rather than declarations.

- **Severity** is pinned by driving all 36 rules through the real command line
  and asserting the exit code, the status, the exact set of rules raised, the
  error, warning and info counts, and the severity word printed on stdout. Each
  rule is a test of its own and every expectation is written inline as a
  literal: that file imports nothing from `src/` and shares no table of cases
  with anything, because a behavioural test that compares against a table the
  same edit touches is a fourth mirror rather than a guard.
- **Ordering** is pinned per call site, on the sequence a real run emits, with
  identifiers where code-unit and collation order genuinely disagree (`README`
  before `assets`, `Z` before `a`, `a-b` before `a_b`). Substituting an
  `Intl.Collator` at any one of the ten comparisons that can change the output
  turns a test red. The eleventh compares rule ids, a closed set of 36 values
  over `[a-z-]` whose 1296 ordered pairs collate exactly as their code units do,
  so no document can make it observable; it is named as such in that file.
- **Sanitising** is pushed through identifiers, declaration keys, type names,
  versions and the workflow label -- not an excerpt field -- for every class in
  the table, including C1 and the bidi controls.
- **No part of the specification is quoted back**, on the error path either. A
  specification that does not parse is reported by position, line and column;
  `JSON.parse` embeds the input in one of its two error messages, so a file
  short enough to be only a credential would otherwise be reproduced in full by
  its own failure -- and sanitising does not remove it, because the quotation is
  at the front of the message and the bound cuts from the back.
- **Incompleteness** has a case per rule that goes red when the rule stops
  marking a run incomplete.

## License

MIT. See [LICENSE](./LICENSE).
