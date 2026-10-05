import {defineField, defineType} from 'sanity'

const KINDS = [
  {title: 'Lipogram (never use a letter)', value: 'lipogram'},
  {title: 'Univocalic (one vowel only)', value: 'univocalic'},
  {title: 'Chain (each line reuses a word from the line above)', value: 'reuseWord'},
  {title: 'Syllable pattern', value: 'syllables'},
  {title: 'Acrostic', value: 'acrostic'},
  {title: 'No repeated words', value: 'noRepeat'},
  {title: 'Banned words', value: 'bannedWords'},
  {title: 'Maximum line length', value: 'maxLineLength'},
  {title: 'Line count', value: 'lineCount'},
  {title: 'Forbidden pattern', value: 'forbiddenPattern'},
]

/** Show a params field only for the kinds that use it. */
const forKinds = (...kinds: string[]) => ({document}: {document?: any}) => !kinds.includes(document?.kind)

export const constraint = defineType({
  name: 'constraint',
  title: 'Constraint',
  type: 'document',
  description:
    'A writing rule, stored as content. Poems reference the constraints they follow; changing a constraint re-checks every poem that references it.',
  fields: [
    defineField({name: 'title', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'collection', type: 'reference', to: [{type: 'collection'}]}),
    defineField({name: 'kind', type: 'string', options: {list: KINDS, layout: 'dropdown'}, validation: (r) => r.required()}),
    defineField({
      name: 'params',
      type: 'object',
      fields: [
        defineField({name: 'letters', type: 'string', description: 'Letters that may not appear', hidden: forKinds('lipogram')}),
        defineField({name: 'vowel', type: 'string', options: {list: ['a', 'e', 'i', 'o', 'u']}, hidden: forKinds('univocalic')}),
        defineField({name: 'minWordLength', type: 'number', initialValue: 3, hidden: forKinds('reuseWord')}),
        defineField({name: 'pattern', type: 'array', of: [{type: 'number'}], description: 'Syllables per line, repeating', hidden: forKinds('syllables')}),
        defineField({name: 'word', type: 'string', description: 'First letters of the lines spell this', hidden: forKinds('acrostic')}),
        defineField({name: 'ignore', type: 'array', of: [{type: 'string'}], options: {layout: 'tags'}, description: 'Words that may repeat', hidden: forKinds('noRepeat')}),
        defineField({name: 'words', type: 'array', of: [{type: 'string'}], options: {layout: 'tags'}, hidden: forKinds('bannedWords')}),
        defineField({name: 'maxChars', type: 'number', hidden: forKinds('maxLineLength')}),
        defineField({name: 'minLines', type: 'number', hidden: forKinds('lineCount')}),
        defineField({name: 'maxLines', type: 'number', hidden: forKinds('lineCount')}),
        defineField({name: 'regex', type: 'string', hidden: forKinds('forbiddenPattern')}),
        defineField({name: 'reason', type: 'string', description: 'Shown to the writer, e.g. "exclamation marks"', hidden: forKinds('forbiddenPattern')}),
      ],
    }),
    defineField({name: 'description', type: 'text', rows: 2}),
    defineField({
      name: 'version',
      type: 'number',
      readOnly: true,
      description: 'Bumped by the re-check function each time the params change. Verdicts record the version they were checked against.',
      initialValue: 1,
    }),
  ],
  preview: {select: {title: 'title', subtitle: 'kind', version: 'version'}, prepare: ({title, subtitle, version}) => ({title, subtitle: `${subtitle} · v${version ?? 1}`})},
})
