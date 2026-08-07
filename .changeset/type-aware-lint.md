---
"@ai-translate/core": patch
"@ai-translate/fs-json": patch
"@ai-translate/markdoc": patch
"@ai-translate/message-formats": patch
"@ai-translate/next": patch
"@ai-translate/provider-core": patch
---

Turn on type-aware linting and fix what it found.

The config already asked for `no-floating-promises`, `no-misused-promises`,
`no-confusing-void-expression` and `require-await`, but oxlint skips rules that
need type information unless it is run with `--type-aware` and can find
`oxlint-tsgolint`. Neither was in place, so those four rules had been inert.
Both are now wired into every `lint` script, along with a set of type-aware
rules that were clean on the first run and now hold that line: `await-thenable`,
`no-base-to-string`, `restrict-template-expressions`, `restrict-plus-operands`,
`prefer-readonly`, `use-unknown-in-catch-callback-variable`, and others.

Two real defects came out of it:

- The semantic-audit repair note was assembled as `text + reason ? a : b`.
  Because `+` binds tighter than `?:`, that parsed as `(text + reason) ? a : b`,
  whose left side is a non-empty string and therefore always truthy. Every
  repair prompt lost both the requirement description and the "preserve the
  English meaning" instruction, and printed `undefined` as the diagnostic reason
  when there was none. Now assembled as a single template, with a test that pins
  the note in full.
- Four call sites detached a method from an object supplied by the caller — a
  candidate-cache store, a message format, the Markdoc runtime — and then called
  it unbound, which drops `this` for any implementation written as a class.
  These now call through their receiver.

Rules deliberately left off, with the reasoning recorded in `.oxlintrc.json`:
`no-unnecessary-condition` (reads concurrent state mutated across an `await` as
always-false, and treats runtime guards over unverified JSON as dead code),
`no-unsafe-type-assertion` (the assertions it flags are the correct idiom at
this toolkit's dynamic boundaries), `unicorn/no-array-callback-reference`
(wrapping `filter(isFoo)` in an arrow discards the type predicate), and
`no-loop-func` (a `var`-era rule that here reports only safe code).
