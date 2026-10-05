# Setup: the steps only a person can click

1. sanity.io/manage: create project `lipogram-studio`. Datasets: `production` (**public**) and `workflows` (private).
2. Project > API > Tokens:
   - an **Editor** token: `SANITY_WRITE_TOKEN` (scripts and workflow start)
   - an **Editor** token for the website's sandbox route: `SANITY_SANDBOX_TOKEN`
3. Project > API > CORS: add the site's URL and `http://localhost:3333` (console dev).
4. Note the project id (`SANITY_PROJECT_ID`) and organization id (`SANITY_ORG_ID`).

Then:

```sh
npm install
npm test                                   # checker, engine, workflow bench (23 tests)

# content
npx tsx seed/build-ndjson.ts
cd studio && SANITY_STUDIO_PROJECT_ID=$SANITY_PROJECT_ID npx sanity dataset import ../seed/seed.ndjson production --replace
SANITY_STUDIO_PROJECT_ID=$SANITY_PROJECT_ID npx sanity schema deploy
SANITY_STUDIO_PROJECT_ID=$SANITY_PROJECT_ID npx sanity deploy        # Studio at lipogram-studio.sanity.studio
cd ..

# functions (recheck-constraint, recheck-poem)
npx sanity blueprints init . --type ts --stack-name production --project-id $SANITY_PROJECT_ID   # once; keep the existing sanity.blueprint.ts
SANITY_PROJECT_ID=$SANITY_PROJECT_ID npx sanity blueprints deploy

# workflow
SANITY_PROJECT_ID=$SANITY_PROJECT_ID npx sanity-workflows deploy
SANITY_PROJECT_ID=$SANITY_PROJECT_ID SANITY_WRITE_TOKEN=... npx tsx scripts/start-workflows.ts

# console (App SDK, in the Dashboard)
cd console && SANITY_ORG_ID=... SANITY_APP_PROJECT_ID=$SANITY_PROJECT_ID npx sanity deploy

# website: deploy web/ to Vercel with
#   NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET=production, SANITY_SANDBOX_TOKEN
```

Check the loop end to end: open the pressure chamber, ban a letter, and watch the status line. "Waiting for the recheck function" should turn into "Rechecked N poems" within a few seconds. `npx sanity functions logs recheck-constraint` shows the function's own line.
