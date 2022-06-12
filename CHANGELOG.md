# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface: renaming or removing one is a breaking
change and is recorded here.

## [Unreleased]

### Added

- `analyzeWorkflow` and `validateWorkflowFile` validate a workflow specification
  statically and return both a report and a typed execution contract.
- `workflow-step-contract-validator` command line interface with `--spec`,
  `--contract`, `--json`, `--help` and the nine documented limit flags.
- Compatibility checking for every binding: a missing producer, a type
  disagreement, an optional output against a required consumer, an ambiguous
  duplicate producer, and `minVersion` against the producing step's version with
  caret semantics. A version constraint that could not be checked is reported as
  unknown, never as satisfied.
- Static scheduling: execution stages resolved by Kahn's algorithm, cycles named
  from their code-unit-smallest member, and the steps stranded behind a cycle
  reported separately.
- An execution contract listing the resolved order, every step's stage, where
  each consumed value comes from, the bindings that resolved to nothing, and the
  workflow's exports. Its destination is refused if it resolves to the
  specification itself, with both paths resolved through `realpath`.
- Thirty-six rules with severities pinned in one frozen table and behaviourally
  in the test suite, documented in `docs/contract-rules.md`.
- Nine explicit limits -- bytes, steps, ports per step, dependencies per step,
  provided channels, exports, depth, graph operations and milliseconds -- each
  enforced, each wired to a flag, and each reported by name. A document-level
  limit refuses the document and a step-level limit refuses the step; nothing is
  truncated.
- Stable output: no clock reading, no absolute host path, no locale-dependent
  ordering, and byte-identical stdout for the same specification.

No release has been published.
