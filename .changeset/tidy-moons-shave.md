---
"@ai-translate/provider-openai": minor
"@ai-translate/next": minor
---

Default to `gpt-5.6-luna`, and stop sending a temperature unless one is configured.

The previous default paired a `gpt-5.4` model with a temperature of 0.1, and `ai-translate init` wrote `gpt-4.1-mini` into generated configs. Reasoning models reject any temperature but their own default, so no provider-level value is both safe and meaningful: 0.1 would fail every request on the new default, and 1 would quietly loosen a non-reasoning model a caller chose for determinism. The translation provider now omits it, matching what the semantic audit provider already did.

Callers that set `temperature` explicitly are unaffected.
