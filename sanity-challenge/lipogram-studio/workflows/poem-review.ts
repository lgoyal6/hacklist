// A poem's life as data: drafting, an automatic constraint check, an editor's
// review, publication, and a violated stage it can fall into later when a
// constraint it follows is tightened. Nobody "moves" the instance: transitions
// read the poem's status, which the recheck functions write, and the functions
// tick the instance after every write.
//
// Guards here are advisory (Content Lake does not enforce them yet); the real
// enforcement is the recheck function and the publish action. Said so in the post.
import {
  defineAction,
  defineActivity,
  defineField,
  defineGuard,
  defineStage,
  defineTransition,
  defineWorkflow,
} from '@sanity/workflow-engine/define'

export const poemReview = defineWorkflow({
  name: 'poem-review',
  title: 'Poem review',
  description: 'From draft to published, with every constraint checked by code and a path back when a rule tightens.',
  initialStage: 'drafting',
  start: {
    requirements: [{type: 'singleSubject', name: 'one-run-per-poem', title: 'This poem already has a review in progress'}],
  },
  fields: [
    defineField({type: 'subject', name: 'subject', title: 'Poem', types: ['poem'], required: true, initialValue: {type: 'input'}}),
    defineField({type: 'string', name: 'decision'}),
  ],
  // Role names are Sanity's own project roles: the engine matches them
  // literally against the caller's roles, so an invented "poet" role would
  // leave the submit button disabled for everyone.
  predicates: {
    poemValid: '$fields.subject.status == "valid"',
    poemViolated: '$fields.subject.status == "violated"',
  },
  stages: [
    defineStage({
      name: 'drafting',
      title: 'Drafting',
      activities: [
        defineActivity({
          name: 'write',
          title: 'Write the poem',
          actions: [defineAction({name: 'submit', title: 'Submit for checking', roles: ['contributor', 'editor', 'administrator'], status: 'done'})],
        }),
      ],
      transitions: [defineTransition({name: 'to-checking', title: 'Check constraints', to: 'checking'})],
    }),
    defineStage({
      name: 'checking',
      title: 'Constraint check',
      description: 'No one acts here. The recheck function writes the poem status and ticks this instance.',
      transitions: [
        defineTransition({name: 'passes', title: 'All constraints hold', to: 'review', when: '$poemValid'}),
        defineTransition({name: 'fails', title: 'A constraint is broken', to: 'drafting', when: '$poemViolated'}),
      ],
    }),
    defineStage({
      name: 'review',
      title: 'Editor review',
      guards: [
        defineGuard({
          name: 'freeze-text',
          match: {idRefs: [{type: 'fieldRead', field: 'subject'}], actions: ['update']},
          predicate: '!delta::changedAny((text, constraints))',
        }),
      ],
      activities: [
        defineActivity({
          name: 'decide',
          title: 'Read and decide',
          actions: [
            defineAction({
              name: 'approve',
              title: 'Approve',
              roles: ['editor', 'administrator'],
              status: 'done',
              ops: [{type: 'field.set', target: {field: 'decision'}, value: {type: 'literal', value: 'approve'}}],
            }),
            defineAction({
              name: 'send-back',
              title: 'Send back',
              roles: ['editor', 'administrator'],
              status: 'done',
              ops: [{type: 'field.set', target: {field: 'decision'}, value: {type: 'literal', value: 'send-back'}}],
            }),
          ],
        }),
      ],
      transitions: [
        defineTransition({name: 'to-published', to: 'published', when: '$allActivitiesDone && $fields.decision == "approve"'}),
        defineTransition({name: 'to-drafting', to: 'drafting', when: '$allActivitiesDone && $fields.decision == "send-back"'}),
      ],
    }),
    defineStage({
      name: 'published',
      title: 'Published',
      description: 'Not terminal: a constraint tightened later can still break this poem.',
      transitions: [defineTransition({name: 'broken-by-rule-change', title: 'A constraint was tightened', to: 'violated', when: '$poemViolated'})],
    }),
    defineStage({
      name: 'violated',
      title: 'Violated',
      description: 'Published, then broken by a rule change. Loosen the rule and it returns; or revise it.',
      activities: [
        defineActivity({
          name: 'revise',
          title: 'Revise to fit the new rule',
          actions: [defineAction({name: 'reopen', title: 'Reopen for drafting', roles: ['contributor', 'editor', 'administrator'], status: 'done'})],
        }),
      ],
      transitions: [
        defineTransition({name: 'rule-loosened', title: 'The rule was loosened', to: 'published', when: '$poemValid'}),
        defineTransition({name: 'to-drafting', to: 'drafting', when: '$allActivitiesDone'}),
      ],
    }),
  ],
})
