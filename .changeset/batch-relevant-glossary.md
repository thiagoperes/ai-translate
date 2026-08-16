---
"@ai-translate/core": minor
"@ai-translate/provider-core": minor
---

Send each batch the glossary terms it actually uses

A glossary is corpus-wide — brand names, product nouns, domain vocabulary — while
a batch is a hundred strings. Every call carried all of it, so the bill scaled
with the glossary rather than with the work: measured at 100 keys per call, going
from no glossary to 500 terms took input from 11.4 to 95.7 tokens per key, and
none of those terms appeared in the strings being translated.

The provider engine now narrows the glossary to the terms some source text in the
batch contains, using the same predicate `selectRelevantGlossaryTerms` already
uses to decide whether a term belongs in a candidate's cache key. That closes a
real gap rather than trading quality for tokens: the cache has always claimed a
term absent from the source did not shape the translation, while the prompt said
otherwise, so editing an unrelated glossary term could change output and still
serve a cached entry. Now the two agree.

The default `batching.maxRequestsPerProviderCall` drops from 120 to 100 to match
the batch size the shipped providers default to. Grouping more requests than the
provider will send does not produce larger calls — it splits the group and the
remainder becomes a short call paying a full system prompt and schema for a
handful of keys. On 600 unique entries that was 10 calls where 6 would do, at
61.3 tokens of prompt overhead per key against 55.3.

Glossary selection is part of the translation output contract, so
`TRANSLATION_OUTPUT_CONTRACT_REVISION` rotates: tightening the predicate later
(word boundaries, stemming) would change output, and that has to be visible.
Configs that pin `generationRevision` to the contract revision can list the
previous value in `compatibleGenerationRevisions` to keep existing translations
instead of regenerating them.
