# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface: renaming or removing one is a breaking
change and is recorded here.

## [Unreleased]

### Fixed

- `spec-not-json` no longer quotes the specification back. Its evidence was
  `String(error.message)`, and `JSON.parse` embeds the input in one of its two
  error messages (`Unexpected token 'A', "AKIA..." is not valid JSON`), so a
  specification short enough to be only a credential was reproduced in full in
  the JSON report -- by the finding whose whole purpose is to say that nothing
  was read. `parseFailureDetail` in `src/text.mjs` keeps the position, line and
  column and drops the quotation. `sanitize` would not have caught it: the
  quotation is at the front of the message and the bound cuts from the back.

### Added

- `analyzeWorkflow` and `validateWorkflowFile` validate a workflow specification
  statically and return both a report and a typed execution contract.
- `workflow-step-contract-validator` command line interface with `--spec`,
  `--contract`, `--json`, `--help` and the nine documented limit flags.
- Compatibility checking for every binding: a missing producer, a type
  disagreement, an optional output against a required consumer, an ambiguous
  duplicate producer, and `minVersion` against the producing step's version --
  the same major version, and not older than the minimum, which is deliberately
  not npm's `^` for a `0.x` producer. A version constraint that could not be
  checked is reported as unknown, never as satisfied.
- Static scheduling: execution stages resolved by Kahn's algorithm, cycles named
  from their code-unit-smallest member, and the steps stranded behind a cycle
  reported separately.
- An execution contract listing the resolved order, every step's stage, where
  each consumed value comes from, the bindings that resolved to nothing, and the
  workflow's exports.
- A write guard on the contract destination, refusing the indirections that
  turn a named path into a different file: a symbolic link at the destination,
  refused unresolved because resolving it is the dangerous act; a hard link to
  an input, caught by device and inode, which is the only thing that sees it;
  and a destination that exists and is not a regular file. A refused
  destination is a configuration error -- exit 2, empty stdout, nothing
  written. A new file, a file in a real subdirectory, a path whose parents do
  not exist yet and a directory reached through a symbolic link all remain
  legitimate destinations.
- The guard also refuses a destination whose resolved parent leaves a permitted
  root, resolving the parent first because a lexical prefix test passes for
  `root/link/out` where `link` leaves the root. `--contract` names no such root
  -- a build directory or the system temporary directory is a legitimate
  destination -- so that check is available to an embedder that passes one and
  is not enforced by this command line, where a symbolically linked parent
  directory is followed.
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
