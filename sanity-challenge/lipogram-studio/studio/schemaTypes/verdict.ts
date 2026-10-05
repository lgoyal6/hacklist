import {defineField, defineType} from 'sanity'

export const verdict = defineType({
  name: 'verdict',
  title: 'Verdict',
  type: 'document',
  readOnly: true,
  description: 'One poem checked against one version of one constraint. Written by code only.',
  fields: [
    defineField({name: 'poem', type: 'reference', to: [{type: 'poem'}], weak: true}),
    defineField({name: 'constraint', type: 'reference', to: [{type: 'constraint'}], weak: true}),
    defineField({name: 'constraintVersion', type: 'number'}),
    defineField({name: 'ok', type: 'boolean'}),
    defineField({
      name: 'failures',
      type: 'array',
      of: [
        {
          type: 'object',
          name: 'failure',
          fields: [
            {name: 'line', type: 'number'},
            {name: 'start', type: 'number'},
            {name: 'end', type: 'number'},
            {name: 'message', type: 'string'},
          ],
        },
      ],
    }),
    defineField({name: 'checkedAt', type: 'datetime'}),
    defineField({name: 'checkedBy', type: 'string', options: {list: ['function', 'seed', 'console']}}),
  ],
  preview: {
    select: {poem: 'poem.title', constraint: 'constraint.title', ok: 'ok', v: 'constraintVersion'},
    prepare: ({poem, constraint, ok, v}) => ({title: `${ok ? '✓' : '✗'} ${poem ?? '?'}`, subtitle: `${constraint ?? '?'} v${v ?? '?'}`}),
  },
})
