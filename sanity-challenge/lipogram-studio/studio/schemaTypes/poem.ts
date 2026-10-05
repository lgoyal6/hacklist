import {defineField, defineType} from 'sanity'

import {ConstrainedTextInput} from '../components/ConstrainedTextInput'

export const poem = defineType({
  name: 'poem',
  title: 'Poem',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'author', type: 'string'}),
    defineField({
      name: 'provenance',
      type: 'string',
      options: {list: ['written for this project', 'public domain', 'AI draft, labelled']},
      description: 'Where the text came from. Shown on the public site.',
    }),
    defineField({name: 'collection', type: 'reference', to: [{type: 'collection'}], validation: (r) => r.required()}),
    defineField({
      name: 'constraints',
      type: 'array',
      of: [{type: 'reference', to: [{type: 'constraint'}]}],
      description: 'The rules this poem claims to follow.',
    }),
    defineField({
      name: 'text',
      type: 'text',
      rows: 12,
      description: 'One line per line. Blank lines are stanza breaks.',
      components: {input: ConstrainedTextInput},
    }),
    defineField({
      name: 'status',
      type: 'string',
      readOnly: true,
      options: {list: ['valid', 'violated', 'unchecked']},
      description: 'Written by the re-check function from the latest verdicts.',
    }),
  ],
  preview: {select: {title: 'title', subtitle: 'author', status: 'status'}, prepare: ({title, subtitle, status}) => ({title, subtitle: `${status === 'violated' ? '✗ ' : status === 'valid' ? '✓ ' : ''}${subtitle ?? ''}`})},
})
