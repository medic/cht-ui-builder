<!--
Turn the hand-fixes QA needed during the 2026-08-08 workflow probe into a coherent feature:
make the task -> form data hand-off fully no-code. Covers findings W3 + W4. 2026-08-08.
-->

# Handoff — make the task → form hand-off no-code (W3 + W4)

**Why this exists:** QA proved the geriatric workflow works end to end, but **three of its five
load-bearing joints needed hand-edits a health-post officer cannot perform.** All three sit on
one seam — getting a value *out of the task* and *into the form the task opens*. Fix that seam
and the workflow becomes genuinely no-code.

**The good news: we have already solved this exact pattern once.** `insertContactFieldRef`
(shipped) takes one gesture and produces three artifacts — the harvest `calculate`, placed
correctly, deduped and idempotent, all in a single undoable patch. **This feature is that same
machinery pointed at a different source.** Reuse it rather than inventing.

## What a user has to hand-do today

| # | Hand-fix QA performed | Why the tool forced it |
|---|---|---|
| 1 | Typed the `modifyContent` body as **Raw JS** | The structured picker emits `report.<field>`, but CHT needs **`report.fields.<field>`** — undefined at runtime. And switching one row to custom **resets that row and demotes the whole table to read-only**, so there is no way back to structured. |
| 2 | **Relocated the receiving input nodes with a serializer script** | "+ add inside" on the `inputs` group drops new rows into **`inputs/user/`**, where CHT's content-binding cannot reach them. There is no affordance that puts a field where a task can deliver to it. |
| 3 | (Consequence) accepted that delivered flags **aren't saved** in the follow-up report | The scaffold gates `inputs` on `source='user'`, and **Enketo clears non-relevant values on submit** — so a delivered value vanishes unless a `calculate` harvests it first. The tool can't author that harvest. |

## The design — one affordance, three artifacts

**"Receive a value from the task"** — offered on the *receiving* form, and mirrored from the
task's action editor.

When the author picks a source field on the task's `modifyContent` mapping, the tool should, in
**one undoable patch**:
1. **create the receiving node** in the target form, in the correct place — a child of
   `inputs` (NOT `inputs/user/`), typed `hidden`/`string`, named after the mapping key;
2. **create the harvest `calculate`** that copies it out of `inputs` so the value **persists
   through submit** — the same shape and placement logic as `insertContactFieldRef` (which
   already lands its calc *after* `end group inputs`, for the XPath reason established earlier);
3. **write the `modifyContent` mapping** on the task side, emitting **`report.fields.<field>`**.

The author picks a source field and a destination name. They never see `inputs`, never see a
harvest calculate, never type `report.fields.`.

### Fixes required underneath it
**(a) `modifyContent` source picker emits the wrong path.** Emit `report.fields.<field>`, not
`report.<field>`. Straight bug — and add a round-trip test that pins the emitted string, since
this class has bitten us before.

**(b) Custom-mode is a one-way door.** Switching a row to custom must not reset that row, and
must not demote the rest of the table to read-only. Per-row custom, reversible, the rest stays
structured — the same "structured with a raw escape that doesn't burn the house down" contract
the condition builders already honour.

**(c) "+ add inside" targets the wrong subtree.** On the `inputs` group it must insert as a
child of `inputs` (or `inputs/contact`), never `inputs/user/`. Worth checking whether the same
mis-targeting affects other structural inserts.

## Acceptance
- Build the geriatric follow-up's seven `refer_*` receivers **entirely through the UI** — no Raw
  JS, no script, no manual relocation.
- Deploy, submit an assessment failing one domain, open the task, and confirm the follow-up
  **branches correctly** *and* that the delivered flags are **present in the submitted follow-up
  report** on the instance (finding 3's failure mode is invisible in the UI — it only shows in
  the saved doc).
- Re-run QA's probe with **zero disclosed hand-edits** on this seam. That is the exit criterion.

## Tests
- Unit (`shared/`): the emitted `modifyContent` mapping string; the receiving-node placement
  (child of `inputs`, not `inputs/user`); harvest-calc creation, dedupe, idempotence on
  re-insert — mirror `calcReference.roundtrip.test.ts`'s §5b cases, which already cover this
  shape for contact fields.
- Round-trip: a form gaining a receiver + harvest calc must be byte-stable on a no-op re-save;
  a task gaining a mapping likewise.
- E2E: author one receiver end-to-end and assert **on disk** — the input node, the harvest calc,
  and the task's `report.fields.*` mapping.

## Sizing and sequencing
**Medium**, and it is the difference between "the workflow works if a developer helps" and "a
health-post officer can build it." The three fixes (a)–(c) are small and independently
shippable; the one-gesture affordance is the larger piece and depends on them.

**Not the current focus** — item 8 + W2 ship first. This is the natural next item after, ahead
of the remaining geriatric polish, because it is the last thing standing between the proven
workflow and a no-code one.

## Related, filed separately
- **W5** — `cht-default` doesn't compile as scaffolded (`require('moment')`, no `package.json`).
  Belongs with the per-template compile guard, which never covered that template. Same family as
  the "templates ship required minimal files" directive.
- **W1** — the Tasks-panel save corrupting hand-written `tasks.js`. Different seam (serializer,
  not authoring), and it re-opens the parked safety batch — see `NEXT.md`.
