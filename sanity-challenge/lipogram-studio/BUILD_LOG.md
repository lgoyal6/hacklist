# Build log

Kept from minute one, for the DEV post. The prompts that mattered, what the model got wrong, what I got wrong.

## Day 1

- Idea: constraints as content. A lipogram ("never use the letter e") is a rule a poem follows; store the rule as a document, make poems reference it, and changing the rule re-checks every poem that references it. The same engine is a brand style guide ("never write utilize").
- Checked Sanity's docs before writing code, because the plan depended on two claims that turned out false:
  - The App SDK runs inside the Sanity Dashboard for logged-in project members. It is not for anonymous visitors. So the App SDK app is the editors' console; the public site uses plain live queries.
  - Workflow guards are advisory today ("Content Lake does not enforce deployed guard documents yet"). Enforcement lives in the re-check function and the publish action; the workflow models the process.
- Syllable counting: the first version was a hand-written vowel-group rule. Its own test failed on "poem" and "beautiful". Replaced it with the `syllable` package rather than tuning rules for English by hand. It still says "poem" is one syllable; noted as a limitation.
- @sanity/ui v4 renamed Stack's `space` prop to `gap`. The Studio build passed anyway, because `sanity build` does not type-check; `tsc` caught it.

## Workflows, day 1

- Wrote `poem-review`: drafting, checking (no human; transitions read the poem's status), review, published, violated. Published is not terminal: a tightened rule can still break a poem, and a loosened rule brings it back.
- The engine is a library, not a service. Nothing moves until code calls `fireAction` or `tick`, so the recheck functions tick every poem whose status they change.
- The docs' test-bench example uses actor ids like `"wanda"`. On 0.36.0 that throws: "the engine speaks account-global user ids only". Ids need a `g` prefix (`g-pat`). Found by running the example, not by reading.
- The bench caught a real bug: the published-to-violated test failed because the workflow reads the poem's draft when one exists, and the engine only wrote status to the published document. In production that would have been a poem that never left `published`. The engine now writes status to the draft too.
- The in-memory client the bench uses rejects `transaction().patch(id, {set})`; it wants a patch builder (`client.patch(id).set(...)`). The real client accepts both, so the engine uses the builder.
- Change events now have deterministic ids (`changeEvent-<constraint>-v<version>`), which the bench required and which makes a retried function idempotent.
- End-to-end test, all in memory: publish through the workflow, tighten a constraint, run the real recheck engine, tick, assert `violated`; loosen, assert `published`.

## Seed content

- Ran all 38 seed pieces through the real checker before importing. It caught 4 of my own drafts: "coffee" in a no-e poem, "caked" in another, "cocoa" and "Gone" in a poem allowed only the vowel o, and a chain poem linking lines with "ink", which is under the 4-letter minimum. Fixed the poems, not the rules.
- Public-domain pieces: the opening of Gadsby (E. V. Wright, 1939, a novel written without the letter e), Lewis Carroll's acrostic on Alice Pleasance Liddell (1871), and Poe's acrostic on Elizabeth (1829). Everything else is labelled as an AI draft edited by hand.

## App SDK console

- The App SDK runs in the Sanity Dashboard for project members, so the console is the editors' tool: every rule with its live blast radius, an editor that previews which poems a change would break before committing, the change log, and a live workflow board.
- The workflow board uses `@sanity/workflow-sdk`: `useWorkflowInstances` for the board and `useWorkflowSession` for the detail. The buttons are the engine's evaluation of what this editor may do, not a hand-made list.
- The Workflows docs warn that SDK 3.1 can resolve `@sanity/mutate` 0.18.1, which leaves reads pending. Added the override; `npm ls` confirms 0.18.2.
- @sanity/ui v4 renamed more props than Stack's: `TabList space` is `gap`, `Grid columns` is `gridTemplateColumns`, and `Badge mode` is gone. tsc caught all three; `sanity build` would have shipped them.
