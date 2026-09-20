---
"@ai-translate/provider-openai": patch
---

Defer OpenAI client initialization until the first translation or semantic-audit request. Configuration validation, dry runs, and empty batches now work without an API key; actual requests still require credentials or an explicitly supplied client.
