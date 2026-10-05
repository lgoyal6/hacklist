import {defineField, defineType} from 'sanity'

export const ephemeris = defineType({
  name: 'ephemeris',
  title: 'Ephemeris',
  type: 'document',
  description:
    'One published timing solution for one planet: a reference midtime and a period. ' +
    'Midtimes are normalized to BJD_TDB at import; the original time system is kept.',
  fields: [
    defineField({name: 'planet', type: 'reference', to: [{type: 'planet'}], validation: (r) => r.required()}),
    defineField({name: 'source', type: 'reference', to: [{type: 'source'}]}),
    defineField({
      name: 'origin',
      type: 'string',
      description: 'archive: a row of the NASA Exoplanet Archive. exoclock: the ExoClock project catalogue.',
      options: {list: ['archive', 'exoclock']},
    }),
    defineField({
      name: 'isArchiveDefault',
      title: 'NASA archive default',
      type: 'boolean',
      description: 'The solution the NASA Exoplanet Archive shows by default and most tools read.',
    }),
    defineField({name: 't0BjdTdb', title: 'Reference midtime (BJD_TDB)', type: 'number'}),
    defineField({name: 't0ErrDays', title: 'Midtime 1-sigma (days)', type: 'number'}),
    defineField({name: 'periodDays', title: 'Period (days)', type: 'number'}),
    defineField({name: 'periodErrDays', title: 'Period 1-sigma (days)', type: 'number'}),
    defineField({name: 'timeSystemAsPublished', type: 'string'}),
    defineField({
      name: 'usable',
      type: 'boolean',
      description: 'False when the time system is unknown (an 8-minute ambiguity) or no errors were published.',
    }),
    defineField({name: 'unusableReason', type: 'string'}),
    defineField({name: 'publishedYear', type: 'number'}),
    defineField({
      name: 'assessment',
      type: 'object',
      description: 'Computed against the chosen solution at the build date. Written by code, not by hand.',
      readOnly: true,
      fields: [
        defineField({name: 'verdict', type: 'string', options: {list: ['chosen', 'consistent', 'stale', 'unusable']}}),
        defineField({name: 'offsetMin', title: 'Offset from chosen solution (min)', type: 'number'}),
        defineField({name: 'sigmaMin', title: 'Own uncertainty at build date (min)', type: 'number'}),
        defineField({name: 'tension', title: 'Offset in combined sigma', type: 'number'}),
        defineField({name: 'atBjd', title: 'Evaluated at (BJD_TDB)', type: 'number'}),
      ],
    }),
  ],
  preview: {
    select: {planet: 'planet.name', source: 'source.citation', verdict: 'assessment.verdict', def: 'isArchiveDefault'},
    prepare: ({planet, source, verdict, def}) => ({
      title: `${planet ?? '?'}: ${source ?? 'unknown source'}`,
      subtitle: `${verdict ?? ''}${def ? ' · NASA default' : ''}`,
    }),
  },
})
