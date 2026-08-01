# Ready Knowledge Sources are automatic Workspace knowledge

Ready Knowledge Sources belong to the Workspace, not to an individual Cowork
Turn. The browser does not select or send source identifiers. During turn setup,
the server resolves every ready current source revision and retrieves only the
chunks relevant to the authoritative instruction.

Retrieved chunks are passed through an explicit Workspace Knowledge input to
the writer as well as the in-flight turn history. This keeps direct Create and
Edit workflows from losing Knowledge when they intentionally exclude the
current user message from their conversation digest. Artifact lineage records
only the exact source revisions and chunk identifiers that retrieval actually
used.

Source and chunk embeddings remain durable database records created when a
ready revision changes. Query results use a small bounded process cache keyed by
Workspace, normalized query, embedding model, and the complete ready source
revision set. A revision, title, query, or model change produces a different
key. This cache is an optimization only; every turn still resolves the current
ready revisions, and a cache miss has identical behavior.

Knowledge retrieval is fail-open. A source-list read outage leaves the
Workspace Knowledge input empty. If semantic embeddings are unavailable,
bounded database-ranked lexical retrieval can still supply relevant evidence;
if that also fails, Cowork continues with an empty input. Cancellation and
setup deadlines remain authoritative and are never swallowed.

Knowledge Source contents are untrusted evidence, never operator instructions.
Automatic availability does not promote an extracted personal claim to a
verified Workspace Knowledge Item. A source-only personal experience, belief,
customer, result, date, or metric must not be attributed to the user unless the
authoritative request or verified Workspace profile independently supports it.
Existing approval and provenance rules for those claims remain in force.
