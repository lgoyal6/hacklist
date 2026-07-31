# Hacklist SF prototype

## Scope

The first city is the San Francisco Bay Area, using a 55-mile radius so events
in Oakland, Berkeley, the Peninsula and the South Bay can be included without
pretending they are all inside San Francisco proper.

## Discovery model

The crawler starts with Luma city/category pages and known calendars, then
expands through event pages, presenting calendars, organizers and co-hosts.
Known collections are seeds, not authoritative inventories.

Candidate generation is deliberately broad. Publication requires page-level
evidence of building plus a competitive or submission format. This is how names
such as "Pizza Agent Challenge" can qualify while ordinary pitch nights and
meetups are excluded.

## Ranking

- 40% hackathon confidence: building, teams, submissions, judges, demos, prizes.
- 25% builder value: technical depth, mentors, sponsors and credible tracks.
- 20% accessibility: registration state, price, travel radius and friction.
- 15% freshness: date, recent verification and active registration.

The prototype keeps classification confidence separate from relevance. A real
hackathon can be low relevance when it is far away, closed or already past.

## Refresh

The included workflow runs at 03:00 and 15:00 UTC, roughly 8am and 8pm Pacific.
The production version should use a timezone-aware scheduler to handle daylight
saving transitions exactly.

## Next city

San Diego should reuse the same classifier with a new city boundary, seed set
and place vocabulary. Ranking weights remain stable so cities can be compared.
