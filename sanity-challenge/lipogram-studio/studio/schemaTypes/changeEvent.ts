import {defineField, defineType} from 'sanity'

export const changeEvent = defineType({
  name: 'changeEvent',
  title: 'Change event',
  type: 'document',
  readOnly: true,
  description: 'One constraint change and its blast radius: which poems flipped. The public site replays these.',
  fields: [
    defineField({name: 'constraint', type: 'reference', to: [{type: 'constraint'}], weak: true}),
    defineField({name: 'fromVersion', type: 'number'}),
    defineField({name: 'toVersion', type: 'number'}),
    defineField({name: 'fromParams', type: 'text', description: 'JSON'}),
    defineField({name: 'toParams', type: 'text', description: 'JSON'}),
    defineField({name: 'at', type: 'datetime'}),
    defineField({name: 'source', type: 'string', options: {list: ['studio', 'public-sandbox', 'console', 'seed']}}),
    defineField({name: 'poemsChecked', type: 'number'}),
    defineField({name: 'broke', type: 'array', of: [{type: 'reference', to: [{type: 'poem'}], weak: true}]}),
    defineField({name: 'fixed', type: 'array', of: [{type: 'reference', to: [{type: 'poem'}], weak: true}]}),
  ],
  preview: {
    select: {c: 'constraint.title', from: 'fromVersion', to: 'toVersion', at: 'at'},
    prepare: ({c, from, to, at}) => ({title: `${c ?? '?'} v${from}→v${to}`, subtitle: at}),
  },
})
