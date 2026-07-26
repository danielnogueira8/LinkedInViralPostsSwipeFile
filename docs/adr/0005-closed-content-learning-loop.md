# Content learning is one evidence-backed, versioned loop

SwipeIn models content learning as one Workspace-owned loop connecting a Cowork
Turn, its Artifact, revisions, publication, performance, business outcomes, and
the next recommendation. Content Lineage, Workspace Knowledge, and Workspace
Learning are the three public domain modules for that loop. Delivery surfaces
must use those shared operations rather than creating separate memory,
analytics, or recommendation stores.

Content Lineage is append-only provenance for an Artifact. It records the
direction, applied sources and guidance, origin, generation details, and
extracted content descriptors. Saving an Artifact as a Draft or publishing it
links later lifecycle data to the same lineage; it does not rewrite how the
Artifact was created. Initial rollout expands the schema, dual-writes beside
existing Artifact metadata, measures coverage, and backfills idempotently.
Lineage capture is fail-open: it may be reported and retried, but must never
prevent delivery of an otherwise valid Artifact.

Workspace Knowledge stores source-backed facts a Workspace can credibly use:
stories, beliefs, proof, offers, audience insights, topic expertise, and
prohibitions. Every item carries source, confidence, verification state, and
freshness. Extracted personal claims are proposals until approved; Cowork must
not present an unapproved personal claim as fact. Existing Voice Profile
behavior remains compatible while knowledge is introduced.

Workspace Learning is a versioned snapshot derived from Lineage, revisions,
published-post analytics, and Content Outcomes. Deterministic code owns scores,
sample sizes, baselines, trends, and evidence links. A model may explain those
signals but may not invent or alter them. Every snapshot records both its input
fingerprint and deterministic calculator version. Refresh is replay-safe,
preserves the previous valid snapshot on failure, and uses Voice source
exemplars while a Workspace has fewer than five published Posts.

Content Outcomes record business evidence such as qualified conversations,
leads, calls, pipeline, and revenue. Their source and confidence are explicit;
engagement never implies revenue. Outcome ingestion uses stable idempotency
keys, and corrections append a replacement while preserving the superseded
record and its provenance.

All records are explicitly Workspace-scoped and later tables must enforce the
same scope with row-level security. Contracts are schema-versioned before
persistence. New learning writes and reads degrade safely when their storage
is unavailable. Weekly planning may consume recommendations and request
missing verified context, but users can override every recommendation and
publishing always requires explicit approval.
