import {defineField, defineType} from 'sanity'

export const star = defineType({
  name: 'star',
  title: 'Star',
  type: 'document',
  description: 'A host star. Coordinates are J2000 (ICRS), in degrees.',
  fields: [
    defineField({name: 'name', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'raDeg', title: 'Right ascension (deg, J2000)', type: 'number'}),
    defineField({name: 'decDeg', title: 'Declination (deg, J2000)', type: 'number'}),
    defineField({name: 'vmag', title: 'V magnitude', type: 'number'}),
  ],
  preview: {select: {title: 'name', subtitle: 'vmag'}, prepare: ({title, subtitle}) => ({title, subtitle: subtitle ? `V = ${subtitle}` : ''})},
})
