import {defineField, defineType} from 'sanity'

export const collection = defineType({
  name: 'collection',
  title: 'Collection',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'title'}}),
    defineField({
      name: 'mode',
      type: 'string',
      options: {list: [{title: 'Poetry', value: 'poetry'}, {title: 'Brand style rules', value: 'brand'}]},
      description: 'Same engine, two uses: constraints as an art form, or as a style guide.',
    }),
    defineField({name: 'description', type: 'text', rows: 3}),
    defineField({name: 'sandbox', type: 'boolean', description: 'Visitors may tighten and loosen this collection\'s constraints from the public site.'}),
  ],
})
