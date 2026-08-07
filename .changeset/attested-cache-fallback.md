---
"@ai-translate/core": patch
---

Keep reading an existing candidate cache after the attested gate narrows

Attested and plain candidates live in separate storage, and which one a run uses
follows the configuration rather than the entry. Restricting the attested path to
configurations that actually declare semantic audits was correct, but it left the
corpus of any project that had run `generator-self-check` without audits sitting
behind an API the run no longer called: every entry missed, and every miss went
back to the provider at full price. A plain-mode lookup now falls back to the
attested record and takes its text, which is always sound because an attested
record is a plain record plus provenance.
