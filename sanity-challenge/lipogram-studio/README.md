# Lipogram Studio

Writing rules, stored as content. A lipogram never uses a letter; here every rule like that ("no e", "5-7-5", "never write utilize") is a Sanity document, and every poem references the rules it keeps. Change a rule and a Sanity Function re-checks every poem that references it, writes a verdict per poem, logs who broke and who recovered, and ticks each poem's review workflow, so a published poem moves itself to `violated` and back.

| Part | Where | What it does |
|---|---|---|
| Checker | `packages/checker` | The one implementation of every rule. Used by all surfaces below. |
| Engine | `packages/engine` | Re-check against the Content Lake; tick workflows. Shared by functions, seed and site. |
| Studio | `studio/` | Schema; a text input that highlights violations as you type; a publish button that refuses broken poems. |
| Functions | `functions/`, `sanity.blueprint.ts` | `recheck-constraint` and `recheck-poem`, with GROQ delta filters so their own writes never retrigger them. |
| Workflow | `workflows/poem-review.ts` | drafting → checking → review → published ⇄ violated. Tested in the in-memory bench, including the full loop. |
| Console | `console/` | App SDK app: blast radius of every rule with a preview, change log, live workflow board. |
| Site | `web/` | Public collections, a sandbox where visitors tighten rules, change log. Runs offline on real GROQ (groq-js). |

`BUILD_LOG.md` is the honest record of what broke. `SETUP.md` is the clicks.
