# Workflow & subagent cost-authoring rules

Measured from this project's transcripts (~40–52 workflows, ~400–470 subagents,
~24M tokens): **~90% of subagent spend is workflow fan-out, and it has always run
at Opus tier because no `agent()` call set a model.** These rules fix that. They
apply to `Workflow` scripts and to `.claude/agents/*.md`.

## 1. Tier the model per stage (the 90% lever)
Cheap for mechanical fan-out, top tier only for judgment.
```js
agent(scanPrompt,   { model: 'haiku',  effort: 'low' })  // search / map / grep / extract
agent(refutePrompt, { model: 'sonnet' })                 // redundant "is it real?" voters
agent(synthPrompt,  { effort: 'high' })                  // synthesis / persona lens / final verify
```
Keep Opus on: persona lenses (Bhishan/Lal/Lorena), audit/verify **synthesis**, and
scoping. Those are the stages that actually caught bugs.

## 2. Right-size the fan-out count
`lineage-adversarial-review` spawned **42** Opus agents mostly voting "is this
real?". Majority-of-3 catches almost everything majority-of-N does. Use 3 voters,
not 20+, and put Opus only on the synthesis that reads their votes.

## 3. Dedup before the expensive stage
Collapse duplicate findings in plain code **before** spawning verify agents — never
pay a model to verify the same finding twice.
```js
const fresh = found.filter(f => !seen.has(key(f)));   // plain code, not an agent
```

## 4. `schema:` on every structured stage
Forcing a schema makes the agent return valid structured output and retry at the
tool layer on mismatch — cheaper than re-prompting or parsing malformed text.

## 5. Point fan-out at the cheap custom agents
Use `opts.agentType` so mechanical stages run on the pinned-cheap agent instead of
inheriting the session model:
```js
agent(prompt, { agentType: 'searcher' })      // haiku, read-only location
agent(prompt, { agentType: 'log-scanner' })   // haiku, failure extraction
```

## 6. Cap spend with a budget-aware loop
For open-ended discovery, bound it — don't fan out to the 1000-agent backstop.
```js
while (budget.total && budget.remaining() > 50_000) { /* one more round */ }
```

## 7. `pipeline()` over `parallel()` barriers
`pipeline()` has no barrier between stages: wall-clock = slowest single chain, not
sum-of-slowest-per-stage. Reserve `parallel()` for when a stage genuinely needs ALL
prior results (dedup/merge/early-exit).

## 8. `resumeFromRunId` when iterating
Re-running an edited workflow returns the unchanged prefix from cache instantly —
only the edited/new stages re-run. Don't re-pay for a whole run to change one stage.

## 9. Match the pattern to the ask
"Find any bugs" = a few finders + single-vote. "Audit thoroughly" = larger pool +
3–5-vote adversarial. Don't run the heavy adversarial shape for a light task.

---
The knobs that actually exist: per-tab `/model`, per-call `model:`/`effort:` in
`Workflow` scripts, and `.claude/agents/*.md` frontmatter `model:`. There is no
global "all subagents = haiku" setting — rules 1 & 5 are how you make it durable.
