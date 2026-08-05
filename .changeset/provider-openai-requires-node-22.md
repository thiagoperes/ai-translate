---
"@ai-translate/provider-openai": minor
---

Require Node.js 22 or later, and update the `openai` dependency to 7.1.0.

The v7 SDK declares `engines.node >=22.0.0`, following Node 20 reaching
end-of-life on 2026-04-30. That floor propagates: this package can no longer
honour its previous `>=20.19.0` claim, so `engines` now states `>=22.0.0`.

No API surface changed. openai v7 ships exactly one breaking change — the Node
floor itself — and the request and response shapes this provider uses
(`chat.completions.parse`, `zodResponseFormat`) are byte-identical to v6.

The emitted JSON Schema is also unchanged, so the translation output contract
revision does not move and no cached translations are invalidated.

The other `@ai-translate/*` packages are unaffected and continue to support
Node 20.19 and later.
