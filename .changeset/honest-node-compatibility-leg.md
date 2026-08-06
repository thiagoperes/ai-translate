---
"@ai-translate/provider-core": patch
---

Drop the `openai` dev dependency from `@ai-translate/provider-core`.

The engine is vendor-neutral, but its test harness still rendered request
schemas with `zodResponseFormat` from the OpenAI SDK, which requires Node 22.
That pulled a vendor — and a runtime floor — into a package that claims neither.
The harness now renders the same JSON Schema with `zod`, so the assertions still
compare what a model is actually shown and the package's Node 20.19 claim holds.
