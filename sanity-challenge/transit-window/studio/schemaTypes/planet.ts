import {defineField, defineType} from 'sanity'

export const planet = defineType({
  name: 'planet',
  title: 'Planet',
  type: 'document',
  description:
    'A transiting exoplanet. Every published timing solution is an ephemeris document that ' +
    'references this planet; chosenEphemeris is the one code selected, with the rule and reason.',
  fields: [
    defineField({name: 'name', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'name'}}),
    defineField({name: 'star', type: 'reference', to: [{type: 'star'}]}),
    defineField({name: 'depthMmag', title: 'Transit depth (mmag, R band)', type: 'number'}),
    defineField({name: 'durationHours', title: 'Transit duration (hours)', type: 'number'}),
    defineField({name: 'minTelescopeInches', title: 'Smallest telescope ExoClock recommends (in)', type: 'number'}),
    defineField({
      name: 'ttv',
      title: 'Transit timing variations',
      type: 'boolean',
      description: 'The archive flags this system for TTVs: a linear ephemeris is a poor model here.',
    }),
    defineField({name: 'chosenEphemeris', type: 'reference', to: [{type: 'ephemeris'}], readOnly: true}),
    defineField({
      name: 'selection',
      type: 'object',
      readOnly: true,
      fields: [
        defineField({name: 'rule', type: 'string', options: {list: ['exoclock-fit', 'smallest-propagated-sigma', 'none']}}),
        defineField({name: 'reason', type: 'text', rows: 3}),
        defineField({name: 'corroboration', title: 'Other solutions that agree', type: 'number'}),
        defineField({name: 'driftWarning', type: 'boolean', description: 'Even the chosen solution is drifting from recent observations.'}),
        defineField({name: 'residualMin', title: 'ExoClock latest residual (min)', type: 'number'}),
        defineField({name: 'defaultOffsetMin', title: 'NASA default minus chosen (min)', type: 'number'}),
        defineField({name: 'defaultVerdict', type: 'string'}),
      ],
    }),
    defineField({
      name: 'exoclock',
      type: 'object',
      readOnly: true,
      fields: [
        defineField({name: 'priority', type: 'string'}),
        defineField({name: 'recentObservations', type: 'number'}),
        defineField({name: 'url', type: 'url'}),
      ],
    }),
  ],
  preview: {
    select: {title: 'name', off: 'selection.defaultOffsetMin', v: 'selection.defaultVerdict'},
    prepare: ({title, off, v}) => ({
      title,
      subtitle: typeof off === 'number' ? `NASA default ${off > 0 ? '+' : ''}${off.toFixed(1)} min (${v})` : '',
    }),
  },
})
