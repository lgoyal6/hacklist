// GROQ the app runs against the public dataset. The same projection shape is
// produced offline by lib/local.ts, so the planner never knows the difference.
import groq from 'groq'

const ephemerisFields = `
  "id": _id, t0BjdTdb, t0ErrDays, periodDays, periodErrDays, usable,
  "citation": source->citation, origin`

export const plannerPlanetsQuery = groq`
*[_type == "planet" && defined(chosenEphemeris)]{
  name,
  "slug": slug.current,
  "raDeg": star->raDeg,
  "decDeg": star->decDeg,
  "vmag": star->vmag,
  depthMmag,
  durationHours,
  minTelescopeInches,
  "ttv": coalesce(ttv, false),
  "chosen": chosenEphemeris->{${ephemerisFields}},
  "archiveDefault": *[_type == "ephemeris" && references(^._id) && isArchiveDefault][0]{${ephemerisFields}},
  "driftWarning": coalesce(selection.driftWarning, false),
  "residualMin": selection.residualMin
}`

export const planetDetailQuery = groq`
*[_type == "planet" && slug.current == $slug][0]{
  name,
  "slug": slug.current,
  "star": star->{name, raDeg, decDeg, vmag},
  depthMmag, durationHours, minTelescopeInches, ttv, selection, exoclock,
  "chosenId": chosenEphemeris._ref,
  "solutions": *[_type == "ephemeris" && references(^._id)] | order(coalesce(publishedYear, 3000) desc){
    "id": _id, origin, isArchiveDefault, t0BjdTdb, t0ErrDays, periodDays, periodErrDays,
    timeSystemAsPublished, usable, unusableReason, publishedYear, assessment,
    "source": source->{citation, url, kind, year}
  }
}`
