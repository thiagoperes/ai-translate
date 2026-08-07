---
"@ai-translate/core": patch
---

Stop rescanning every catalog key for characters it almost never contains

Building a JSON Pointer escaped each address segment with two unconditional
`replaceAll` passes, so every segment of every entry in every locale was scanned
and reallocated twice to usually reproduce the identical string. The two
characters JSON Pointer reserves, `~` and `/`, are vanishingly rare in catalog
keys. Checking before rewriting, and appending to a string instead of building
an intermediate array per call, measured about 10% off total sync CPU on an
82,000-entry corpus, with the catalog scan phase itself down by a bit more.
