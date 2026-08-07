---
"@ai-translate/provider-core": minor
"@ai-translate/message-formats": minor
"@ai-translate/markdoc": minor
"@ai-translate/core": minor
"@ai-translate/cli": minor
---

Stop rejecting correct translations, and make semantic preservation free by default.

**Token parity no longer checks order.** `validateTokenParity` compared protected tokens by position, so any translation that moved a placeholder to satisfy target grammar failed. On a 82,335-pair production corpus, five of the seven reported failures were correct translations — German fronting `{{count}}` ahead of `{{language}}`, Irish reordering a parenthetical, Lithuanian moving `{{method}}` before `{{time}}`.

The consequence was worse than a noisy report. With the default `candidateRepairAttempts: 0`, a failed candidate is discarded and the entry marked `failed`, leaving the target absent and the string falling back to source at runtime. Because the model keeps producing the same correct text, it failed identically on every subsequent sync — a permanent hole that never healed.

Parity now compares tokens as a set and ignores position entirely. Placeholders resolve by name and indexed tags by index, so order never carried meaning.

**Severity now follows runtime impact.** Placeholder and tag differences stay errors: a dropped one loses data, an invented one renders as literal braces. Markdown differences — emphasis, inline code, link destinations, formatting-scope expansion — are warnings that record and ship. The same corpus now reports one error, a genuine dropped `{{last4}}`, plus two warnings.

Issue codes `token-count-mismatch` and `token-order-mismatch` are replaced by `token-missing` and `token-unexpected`, which name the differing token. Update any `validation.existingIssueSeverity` keys.

Two boundaries stay strict, because there the tokens are masked placeholders the model must echo back verbatim rather than translator judgement: Markdoc write-time structure checks, where the value is spliced into an AST and markdown *is* structure, and provider-level protected-text restoration.

**`semanticAuditExecution` now defaults to `generator-self-check`.** Self-check folds semantic preservation into the translation request for zero extra provider calls, against one or two calls per 50-entry batch for a separate replay. Set `"provider"` to keep a second model's independent opinion.

Flipping that default surfaced two places where the mode was standing in for "attestations are required", both of which would have silently degraded every existing setup:

- The candidate cache switches to the optional `getAttested`/`putAttested` pair in self-check mode, and both call sites bail out silently when a store does not implement them. Every ordinary `get`/`put` store would have stopped caching with no error and a doubled model bill.
- Segment-delta reuse disabled itself in self-check mode.

Both now key off whether semantic audits are actually configured. With none, nothing can demand an attestation, so caching and delta reuse behave exactly as before.

Generated entries no longer carry an empty `validationAudits: {}`, which self-check would otherwise have written onto every entry in the state file.
