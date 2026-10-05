import {defineField, defineType} from 'sanity'

export const source = defineType({
  name: 'source',
  title: 'Source',
  type: 'document',
  description: 'Where an ephemeris was published: a paper, a catalogue, or a database.',
  fields: [
    defineField({name: 'citation', type: 'string', validation: (r) => r.required()}),
    defineField({
      name: 'kind',
      type: 'string',
      options: {list: ['paper', 'catalogue', 'database']},
    }),
    defineField({name: 'year', type: 'number'}),
    defineField({name: 'url', type: 'url'}),
    defineField({name: 'archiveKey', title: 'Archive reference key', type: 'string', readOnly: true}),
  ],
  preview: {select: {title: 'citation', subtitle: 'kind'}},
})
