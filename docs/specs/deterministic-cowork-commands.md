# Deterministic Cowork Commands

## Outcome

Cowork exposes one visible command for every turn: Ask, Create, or Edit. The command, not the wording of the instruction or prior conversation state, determines the authorized outcome.

## Command interface

- **Ask** may answer, critique, brainstorm, or research using read-only context. It emits no Post and performs no board mutation.
- **Create** produces exactly the explicitly selected number of new Posts. It cannot update any existing Post ID.
- **Edit** requires one canonical Post ID and updates only that ID. It cannot create another Post.
- A missing, stale, or invalid target produces a clarification or conflict with no side effect.
- Board actions use existing explicit buttons or a separately typed management command; ordinary Cowork text cannot authorize them.

The command is scoped to one turn. Create and Edit reset to safe Ask after submission. Conversation history supplies content context only and cannot select the next command.

## User interface

The composer always shows Ask, Create, and Edit. Ask is the safe default. Create exposes an exact Post count. Edit exposes a canonical Post picker and an explicit Whole Post or Hook only scope; Send is disabled until a valid Post is selected. With one Post, Edit selects it automatically. With multiple Posts, the current expanded Post is preselected and the picker can change it. With no Posts, Edit explains that there is nothing to edit and cannot send. A Post card's Edit action enters this same composer mode with that Post preselected. Starter cards set their known command from stable starter metadata rather than prompt wording.

If text appears to request another operation, Cowork may offer a non-authoritative suggestion. Nothing executes until the user selects that command.

## Server flow

1. Parse and validate the typed command.
2. Resolve referenced IDs against canonical Workspace and conversation state.
3. Compile exactly one plan whose executor has only the required authority.
4. Buffer model output and validate its command contract.
5. Commit atomically or persist no deliverable.

Retries replay the persisted command, target, source selection, count, and scope. Pending clarification answers fill only the missing field of the saved command and do not re-enter global routing.

## Compatibility migration

The first deploy accepts the previous request shape only for cached browser bundles and records that path. The current browser sends typed commands for ordinary sends, starters, and card edits. Retry and clarification answers deliberately omit a new command so the server replays the persisted operation marker and configuration. Once compatibility traffic reaches zero, the legacy refine fields and free-text operation compiler are deleted rather than layered beneath the command interface.

## Acceptance invariants

- Arbitrary Ask text creates and edits zero Posts.
- Arbitrary Create text creates exactly the selected count and changes zero existing IDs.
- Arbitrary Edit text changes exactly the selected ID and creates zero IDs.
- Prior turns, selected cards, pending questions, and pinned context cannot alter the current command.
- Invalid commands, stale targets, executor violations, cancellation, and retries cannot partially persist output.
- User-facing interfaces say Post, Hook, Source, and Draft; Artifact remains internal storage vocabulary.
