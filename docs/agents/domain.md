# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root, when it exists.
- `docs/adr/` entries that touch the area being changed.

If either is absent, proceed silently. Domain-modeling flows create them lazily when terminology or a hard-to-reverse decision needs to be recorded.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
└── docs/adr/
    ├── 0001-example-decision.md
    └── 0002-example-decision.md
```

## Use the glossary's vocabulary

When an issue, test, interface, or proposal names a domain concept, use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is missing, reconsider whether the new language is necessary. Record genuine terminology gaps through the domain-modeling flow.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
