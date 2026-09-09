# Recommender evaluation

Verdict: **Implemented result pending**

## What this is, and what it is not

- Traffic: SYNTHETIC ONLY. Every row in this log is seeded, synthetic, developer or replay traffic. Nothing here is a measurement of how anybody uses the board.
- Offline numbers: The offline table below carries NO quality claim. The fixture's reader is a linear function of the same features the ranker gets and is examined at exactly the propensity the trainer assumes, so a win here shows the pipeline runs and a loss would show a bug.
- Implemented or measured: Implemented and exercised locally. Nothing in this file is an online lift measurement.
- Local or deployed: Produced locally from a committed log. The board has not been deployed with logging enabled by this branch.

Log `tests/fixtures/recommender-synthetic-events.jsonl` (4282 rows: 4282 synthetic), artifact `data/ranker.json` (syn-981390602e).

## Organic gate

Only rows tagged source=web count. Seeded, synthetic, developer and replay rows never count.

| Requirement | Have | Need | Met |
| --- | ---: | ---: | --- |
| organic impressions | 0 | 500 | NO |
| organic interactions | 0 | 50 | NO |
| anonymous clients | 0 | 25 | NO |
| full days | 0 | 7 | NO |

The gate is NOT met, so no online result is claimed and the verdict cannot be a promotion.

## Leakage

Two prongs. Every field outside the manifest's allow-list is perturbed and the feature vector must not move. And the only accessor that can reach engagement is alarmed: asking about any instant at or after the impression records a violation.

- Detected: **no**
- Reads of engagement at or after the impression: 0
- Features that moved when a disallowed field moved: 0

## Negative controls

| Control | Expected | Behaved as expected |
| --- | --- | --- |
| leak-future | no leakage from the production extractor (run --control leak-future to watch the detector fire) | yes |
| shuffle-labels | a candidate trained on shuffled labels must not beat production | yes |
| cold-start | a client with no history receives exactly the production ordering | yes |
| missing-artifact | a missing model artifact yields the production ordering, deterministically | yes |

## Offline

prequential, rolling by calendar day (UTC): 14 of 15 days evaluated, 190 rendered lists scored over a judged universe of 40 events.

Each ordering re-ranks only the items its render actually showed, because those are the only items with a label. An ordering that would have surfaced an unlogged event is neither credited nor punished for it.

| Ordering | NDCG@5 | NDCG@10 | MRR | recall@10 | coverage@10 | regions@10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| production | 0.3317 [0.2642, 0.401] | 0.3804 [0.311, 0.4516] | 0.4558 [0.378, 0.5333] | 0.4885 [0.4092, 0.5663] | 11 | 1 |
| popularity | 0.4448 [0.3785, 0.5141] | 0.4955 [0.4325, 0.56] | 0.5238 [0.4537, 0.5967] | 0.6673 [0.6, 0.7328] | 18 | 1 |
| recency | 0.3317 [0.2642, 0.401] | 0.3804 [0.311, 0.4516] | 0.4558 [0.378, 0.5333] | 0.4885 [0.4092, 0.5663] | 11 | 1 |
| random | 0.1463 [0.1105, 0.1808] | 0.2331 [0.1893, 0.2757] | 0.2262 [0.1888, 0.2664] | 0.4563 [0.3661, 0.5401] | 40 | 1 |
| candidate | 0.3802 [0.3021, 0.4562] | 0.4336 [0.3603, 0.5054] | 0.4624 [0.3714, 0.5476] | 0.5868 [0.5168, 0.6612] | 38 | 1 |

Intervals are 95 percent percentile bootstrap, 2000 resamples, resampled by client.

## Online: team-draft interleaving

- **Every row in the log**: 104 drafted lists across 26 clients. 45 wins, 14 losses, 45 ties. Delta 0.2981 (95% CI [0.1959, 0.41]). Lower bound above zero: yes.
- **Organic rows only**: 0 drafted lists across 0 clients. 0 wins, 0 losses, 0 ties. Delta n/a. Lower bound above zero: NO.

## Promotion gate

| Condition | Status |
| --- | --- |
| no leakage | yes |
| all controls behaved | yes |
| beats best frozen baseline | NO |
| best frozen baseline | popularity |
| wins organic interleaving | NO |
| diversity held | yes |
| organic gate met | NO |

Verdict: **Implemented result pending**

## Limitations

- No organic traffic exists. Every number above other than the gate counts comes from a synthetic fixture, and the fixture is rigged in the ranker's favour: its reader's taste is linear in the same features the ranker gets, and examination falls at exactly the propensity the trainer assumes.
- Offline re-ranking scores only the items a render actually showed, because those are the only items with a label. An ordering that would have surfaced something the reader never saw is neither credited nor punished.
- Position bias is corrected with an assumed 1/rank examination curve. It has not been fitted, and fitting it needs a position-swap experiment on real traffic.
- Bootstrap units are client ids, and client ids rotate every seven days, so one long-lived reader appears as several clients. The intervals are therefore slightly narrower than the truth, which is an error in the direction of overconfidence.
- Regional coverage cannot discriminate on this board: the first paint is a single region, so every ordering scores one region. The check is in place for the day a render spans more.
- A save is feed-level on this board, because subscribing covers a whole region. It therefore labels no event, and the click-or-save label is driven entirely by clicks.
- The inverse-propensity weight is applied to every training row rather than to the clicked rows alone. That is what the frozen manifest specified and what was run; weighting only the positives is the more standard form of the correction and is the first thing to change in a next round, before any organic data is collected.

