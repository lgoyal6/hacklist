# Setup: the steps only a person can click

Everything else is scripted. These need the Sanity web UI.

## 1. Project and dataset

1. sanity.io/manage: create project `transit-window`, dataset `production`, visibility **public**.
2. Project > API > Tokens: create an **Editor** token. Save as `SANITY_WRITE_TOKEN`.
3. Note the project id: `SANITY_STUDIO_PROJECT_ID` and `NEXT_PUBLIC_SANITY_PROJECT_ID`.

Then from this repo:

```sh
npm run ingest            # NASA archive + ExoClock -> data/catalog.json
npm run export            # -> data/sanity.ndjson (7,482 documents)
cd studio && npm install
npx sanity dataset import ../data/sanity.ndjson production --replace --token "$SANITY_WRITE_TOKEN"
npx sanity schema deploy  # Context GROQ mode refuses to serve without a deployed schema
npx sanity deploy         # optional: hosted Studio at transit-window.sanity.studio
```

## 2. Context (organization Labs)

1. sanity.io/manage > your organization > Labs: enable **Context** and **Knowledge Bases**.
2. Organization > API > Tokens: create an **organization** token with **Context Viewer**. A project token is refused (403 `contextGrantRequired`). Save as `SANITY_ORGANIZATION_TOKEN`.

## 3. Knowledge Base

Dashboard > Context > New knowledge base.

- Title: `Transit timing`
- Purpose:
  > Helps amateur and student observers decide which published timing to trust for a transiting exoplanet, and explains why sources disagree: stale ephemerides, time systems, orbital decay, and transcription errors.

Sources:

1. **Files**: upload every file in `kb/papers/` (21 Markdown files: arXiv abstracts, with the XO-3b ephemeris quoted from its paper).
2. **Website**: `https://www.exoclock.space/database/planets/` is too broad; add these pages one by one:
   `https://www.exoclock.space/database/planets/XO-3b/`, `.../HAT-P-37b/`, `.../KELT-9b/`, `.../WASP-12b/`, `.../HD97658b/`, `.../KELT-18b/`, `.../GJ436b/`
3. **Dataset**: project `transit-window`, dataset `production`, query:

```groq
*[_type == "planet" && name in [
  "XO-3b","HAT-P-37b","KELT-9b","WASP-12b","HD97658b","KELT-18b","GJ436b","WASP-4b",
  "HD189733b","WASP-43b","TrES-3b","WASP-19b","Qatar-1b","HAT-P-19b","HAT-P-32b",
  "WASP-33b","CoRoT-11b","WASP-10b","WASP-2b","KELT-23Ab","WASP-185b","WASP-31b",
  "KELT-12b","HATS-58Ab","WASP-52b"
]]{
  name,
  "timingUsed": chosenEphemeris->{"source": source->citation, t0BjdTdb, periodDays},
  "decision": selection{rule, reason, corroboration, driftWarning, defaultOffsetMin},
  "publishedSolutions": *[_type == "ephemeris" && references(^._id) && usable]{
    "source": source->citation, publishedYear, isArchiveDefault,
    t0BjdTdb, periodDays, timeSystemAsPublished,
    "predictsNextTransitMinutesFromTimingUsed": assessment.offsetMin
  }
}
```

That is about 60 documents in total, inside the 150-document beta limit.

Press **Build entries**. When it reads "Entries up to date", open **Issues** and screenshot every one before resolving anything. For each issue, note real or false positive. These counts go in the post.

## 4. Two MCP endpoints

Dashboard > Context > New MCP. Two of them, because an endpoint with a dataset source ignores Knowledge Base sources.

| | GROQ endpoint | KB endpoint |
|---|---|---|
| Title | Transit Window data | Transit Window knowledge |
| Name | `transit-window-data` | `transit-window-kb` |
| Sources | dataset `transit-window.production` | the `Transit timing` knowledge base |
| GROQ filter | `_type in ["planet", "ephemeris", "source", "star"]` | (none) |

Instructions for the GROQ endpoint:

> Planet names have no spaces ("HAT-P-37b"). The timing to use is planet.chosenEphemeris; selection.reason says why. Ephemeris documents reference their planet; query them with references(). Midtimes are BJD_TDB; never convert them yourself, call predict_transit.

The endpoint URLs are `https://api.sanity.io/v1/context/organizations/<org id>/mcp/transit-window-data` and `.../transit-window-kb`. Save as `SANITY_CONTEXT_GROQ_URL` and `SANITY_CONTEXT_KB_URL`.

Check both:

```sh
curl -X POST "$SANITY_CONTEXT_GROQ_URL" -H "Authorization: Bearer $SANITY_ORGANIZATION_TOKEN" \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 5. Run

```sh
npm run eval -- --split all     # writes eval/results.json, shown on /proof
npm run build && npm start
```

Deploy to Vercel with the variables in `.env.example`.
