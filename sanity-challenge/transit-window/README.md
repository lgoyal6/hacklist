# Transit Window

Which exoplanet transits can you see tonight, and which published timing should you trust?

NASA's Exoplanet Archive default ephemeris predicts the wrong transit time by 10 minutes or more for 175 of 498 planets amateurs can observe (`npm run stats`). Transit Window keeps every published timing solution as structured content in Sanity, picks one by a rule written in code, and lets an agent explain the choice using Sanity Context (GROQ mode plus a Knowledge Base of the papers).

- `lib/` timing engine (time systems, ephemeris propagation, observability), checked against astropy
- `scripts/ingest.ts` NASA archive + ExoClock to `data/catalog.json`; `scripts/export-sanity.ts` to NDJSON
- `scripts/stats.ts` the headline numbers, with filters
- `kb/papers/` Knowledge Base file source
- `eval/` 45 questions with astropy ground truth; three-arm runner
- `app/` Next.js site; `studio/` Sanity Studio
- `SETUP.md` the clicks; `BUILD_LOG.md` what went wrong

```sh
npm install && npm test
npm run dev   # works offline from committed fixtures
```
