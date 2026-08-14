# Condense Generated Documentation (shared sub-procedure)

Reference fragment, not a slash command. Cited by any agent or command that writes a
long-form prose document to disk.

**The rule**: every generated prose document goes through `@condense-verified` before it
is presented as final. A doc-writing agent researches for a long time and then writes at
the length its research happened to reach, which is not the length the reader needs. The
condense pass is a separate cheap read whose only job is to cut.

Do not condense with the calling agent's own tokens. Dispatch the subagent — the point is
that the verbose draft leaves the caller's context and a shorter document comes back.

## Which agent to dispatch

Always `@condense-verified`, never `@condensor` directly, for anything written to disk.
`@condense-verified` dispatches `@condensor` on Sonnet and then verifies the result against
the source, patching dropped identifiers, softened prohibitions, reversed ordering, and
invented claims. Every artifact covered by this fragment is read downstream as authoritative
— a TDD grounds a whole backlog, a research sidecar grounds every ticket in an Epic — so an
unverified condensation is the wrong trade.

`@condensor` alone is fine for throwaway chat output nobody stores.

## Dispatch shape

1. **Write the draft to its target path first.** Pass `@condense-verified` the file path,
   not the body. Passing inline text carries the verbose draft through context twice, which
   is the cost the condense step exists to avoid.
2. **One `Agent` call**, `subagent_type: condense-verified`. Tell it the output path is the
   same path — it condenses in place.
3. **State the invariants it must not break.** `@condense-verified` protects claims
   generically; it does not know that `**Repos**:` must survive as the first non-blank line
   under each capability H2, or that an H2 must match a TDD heading verbatim. Name the
   structural contracts explicitly in the prompt.

## Re-validate structure after condensing

Whenever the caller validated the draft's shape before writing, **run the same validation
again on the condensed result.** Condensing can drop a load-bearing line that the
pre-write check confirmed was present, and the downstream consumer of these files is a
parser, not a reader — a sidecar H2 that no longer matches its capability heading reads to
`@planner` Phase 2c as a research gap, and a missing `**Repos**:` line is a hard refusal in
init.

If the condensed version fails a structural check, do not hand-repair it into shape and do
not re-dispatch. Keep the pre-condense draft, write that, and tell the user the condense
pass was discarded and why. The verbose document is correct; a short one that breaks the
parser is not.

## What is out of scope

Do **not** route these through a condense pass:

- **Machine-parsed artifacts** — the `/jay-pr-review` plan (`- [ ]` checkboxes consumed by
  `post-review-summary` and `pr-execute-plan`) and the `/plan-ticket` plan file (consumed by
  `sync-plan` and `/ticket-work` S4.2). Both are already length-capped by their own specs,
  and both would lose task granularity to a pass whose instinct is to merge bullets.
- **Gherkin acceptance criteria.** AC is a contract; it is kept verbatim. `@planner`'s
  Output Style already says so.
- **Ticket bodies and chat output.** These are governed by the **Output Style** section of
  `agents/planner.md`, which is a prose spec applied while writing. Condensing is for prose
  already written to a file.
- **Anything under ~40 lines.** `@condense-verified` will correctly return it unchanged, so
  the dispatch buys nothing.
