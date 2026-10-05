# Build log

Written as it happened, for the DEV post. Mistakes included.

## The claim, checked before any code

- The idea came from comparing NASA Exoplanet Archive default ephemerides against the ExoClock catalogue. First pass: curl got a Cloudflare "you have been blocked" page with HTTP 200. A user agent fixed it. The TAP firewall also rejects `IN (...)` lists and `%` wildcards, so the ingest pulls every row with an ephemeris and filters locally.
- First headline was "4 in 10 planets". After adding the corroboration rule, excluding TTV systems and only counting planets where the rule itself trusts ExoClock, it became 175 of 498 off by 10+ minutes (35%), and 33 off by 10+ minutes outside 3 sigma of their own stated error. The post uses the smaller numbers.

## Time systems

- Wrote BJD_TDB to UTC with astronomy-engine (barycentric light time, then TDB to UTC with a leap second table). Checked against astropy for 50 planets: 0.027 s worst case. Altitudes within 0.006 degrees.
- The archive labels midtimes "BJD", "BJD-TDB", "BJD-TBD" (sic), "HJD", "JD", or nothing. A bare "JD" could be geocentric or barycentric, an 8-minute ambiguity, so those rows are kept but never used.

## The selection rule, wrong twice

1. "Always trust ExoClock" failed on HIP 41378 e, whose ExoClock uncertainty tonight is millions of minutes. Changed to: prefer ExoClock only when its propagated uncertainty is within 2x of the most precise solution.
2. "Smallest propagated uncertainty wins" would have picked XO-3b's archive default, which has a tiny error bar and is 14.8 hours off. Added corroboration: a solution must agree with at least one other published solution before it can be chosen.

## XO-3b

The archive default (Rusznak et al.) gives T0 = 2457424.98786. The paper's own fitted-parameter table gives T_C = 2457417.98762 (arXiv:2412.04438, "Time of conjunction - 2457417: 0.98762"). Seven days, not a whole number of 3.19-day orbits. Every tool that reads the archive default for XO-3b predicts transits about 15 hours off. Quoted in the Knowledge Base so the build can raise it as a conflict against the dataset.

## Sanity

- Document ids with a dot are not readable without a token. The first export used `planet.wasp12b`; a public dataset would have looked empty to judges. Switched to dashes.
- Free plan caps a dataset at 10,000 documents. Scoped to the 776 planets ExoClock monitors: 7,482 documents.
- Context MCP: an endpoint with a dataset source serves GROQ tools and ignores Knowledge Base sources, so the agent connects to two endpoints.
- Knowledge Base beta limit is 150 documents, so the KB gets 21 paper files, 7 ExoClock pages, and a dataset source projecting 25 planets with their solutions embedded (one document each).

## Agent

- Claude via the Anthropic SDK in a manual tool loop, MCP via the official MCP client. The model never does time arithmetic: two local tools wrap the same engine as the website.
- Every number in an answer is checked against the text of the tool results. Unsupported numbers are shown in the UI and fail the eval.
