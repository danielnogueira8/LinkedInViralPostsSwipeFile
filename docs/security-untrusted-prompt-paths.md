# Untrusted Prompt Path Audit

This checklist tracks paths where attacker-controlled text reaches a model prompt.
All rows should use `lib/agent/untrusted.ts` helpers for envelope wrapping or
boundary neutralization.

| Path | Source | Current guard |
| --- | --- | --- |
| Chat model source | `chat_modeling_sources.post_text` for swipe/template/draft modeling | `wrapUntrustedDelimited` in chat stream |
| Chat text attachments | user-uploaded text file body and filename | `safeFilename` + `wrapUntrustedDelimited` in chat stream |
| Voice synthesis | scraped LinkedIn post bodies | `wrapUntrustedXml("post", ...)` + shared `INJECTION_GUARD` |
| Hook extraction | scraped LinkedIn post body | `wrapUntrustedXml("post", ...)` + shared `INJECTION_GUARD` |
| Creator style synthesis | tracked/saved/scraped creator posts | `wrapUntrustedXml("post", ...)` + shared `INJECTION_GUARD` |
| No-model format examples | curated exemplar post bodies | `neutralizeMarkers` on load + `wrapUntrustedDelimited` on render |
| Cite resolution | swipe-file post text used in rendered citation metadata | `neutralizeMarkers` |
| Grounded research answers | swipe-file, web, news, and attachment evidence summarized as chat text | static `wrapUntrustedDelimited` evidence blocks + shared `INJECTION_GUARD` |
| Chat title generation | first user/assistant snippets | `neutralizeMarkers` |
| Model-source staging | post/template/draft text saved for later chat modeling | `neutralizeMarkers` before insert |
| Model Source semantic blueprint | forced-tool analysis derived from selected source and user text | `wrapUntrustedDelimited` in `renderModelSourceBlueprint` + shared `INJECTION_GUARD` |

Notes:

- File attachments sent as provider `file` blocks are still bounded by size caps
  in the chat stream route. Their provider-side extracted text is covered by the
  agent system prompt's attachment/data warning, but not by local text wrapping
  because the server does not parse those files before sending them.
- Future features that place third-party or user-uploaded bodies in prompts
  should import `INJECTION_GUARD` and one of the shared wrappers instead of
  hand-rolling delimiters.
