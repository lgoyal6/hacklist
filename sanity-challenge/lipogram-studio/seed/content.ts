// Seed content. Provenance is stated on every piece and shown on the site:
//   "public domain"            published long enough ago to be free to reuse
//   "AI draft, labelled"       written with an AI model for this project, edited by hand
// Nothing here is presented as a human poet's work unless it is one.

export interface SeedCollection {
  key: string
  title: string
  mode: 'poetry' | 'brand'
  sandbox: boolean
  description: string
}
export interface SeedConstraint {
  key: string
  collection: string
  title: string
  kind: string
  params: Record<string, unknown>
  description?: string
}
export interface SeedPoem {
  key: string
  collection: string
  title: string
  author: string
  provenance: 'public domain' | 'AI draft, labelled' | 'written for this project'
  constraints: string[]
  text: string
}

export const collections: SeedCollection[] = [
  {
    key: 'poetry',
    title: 'Constrained verse',
    mode: 'poetry',
    sandbox: false,
    description: 'Poems that follow rules. Each rule is a document; each poem lists the rules it keeps.',
  },
  {
    key: 'chamber',
    title: 'The pressure chamber',
    mode: 'poetry',
    sandbox: true,
    description: 'Anyone can tighten these rules from the site. Watch which poems survive.',
  },
  {
    key: 'brand',
    title: 'Northwind Coffee style guide (fictional)',
    mode: 'brand',
    sandbox: true,
    description: 'The same engine as a style guide. Northwind Coffee is made up; the rules are the kind real teams keep.',
  },
]

export const constraints: SeedConstraint[] = [
  // poetry
  {key: 'no-e', collection: 'poetry', title: 'No e', kind: 'lipogram', params: {letters: 'e'}, description: 'The most common letter in English, gone.'},
  {key: 'only-o', collection: 'poetry', title: 'Only o', kind: 'univocalic', params: {vowel: 'o'}},
  {key: 'haiku', collection: 'poetry', title: '5-7-5', kind: 'syllables', params: {pattern: [5, 7, 5]}},
  {key: 'chain', collection: 'poetry', title: 'Chain', kind: 'reuseWord', params: {minWordLength: 4}, description: 'Every line picks up a word from the line before.'},
  {key: 'acrostic-alice', collection: 'poetry', title: 'Acrostic: ALICE PLEASANCE LIDDELL', kind: 'acrostic', params: {word: 'ALICEPLEASANCELIDDELL'}},
  {key: 'acrostic-elizabeth', collection: 'poetry', title: 'Acrostic: ELIZABETH', kind: 'acrostic', params: {word: 'ELIZABETH'}},
  {key: 'acrostic-moon', collection: 'poetry', title: 'Acrostic: MOON', kind: 'acrostic', params: {word: 'MOON'}},
  {key: 'once', collection: 'poetry', title: 'Every word once', kind: 'noRepeat', params: {ignore: ['a', 'an', 'the', 'and', 'of', 'to', 'in', 'i']}},
  {key: 'short', collection: 'poetry', title: 'Short lines', kind: 'maxLineLength', params: {maxChars: 48}},
  // chamber: start loose; visitors tighten
  {key: 'chamber-letters', collection: 'chamber', title: 'Banned letters', kind: 'lipogram', params: {letters: 'z'}},
  {key: 'chamber-width', collection: 'chamber', title: 'Line width', kind: 'maxLineLength', params: {maxChars: 60}},
  {key: 'chamber-length', collection: 'chamber', title: 'Poem length', kind: 'lineCount', params: {minLines: 1, maxLines: 12}},
  // brand
  {key: 'brand-plain', collection: 'brand', title: 'Plain words', kind: 'bannedWords', params: {words: ['utilize', 'leverage', 'synergy', 'world-class', 'delve', 'seamless', 'game-changer']}},
  {key: 'brand-calm', collection: 'brand', title: 'No shouting', kind: 'forbiddenPattern', params: {regex: '!+', reason: 'exclamation marks'}},
  {key: 'brand-width', collection: 'brand', title: 'Readable lines', kind: 'maxLineLength', params: {maxChars: 110}},
]

const pd = 'public domain' as const
const ai = 'AI draft, labelled' as const

export const poems: SeedPoem[] = [
  // ---- no e ----
  {key: 'moon-script', collection: 'poetry', title: 'Moon script', author: 'Studio desk', provenance: ai, constraints: ['no-e', 'short'], text:
`a moon is full,
its light a calm warm gold
on roofs and wild salt grass,
on boats that rock and hold.`},
  {key: 'morning-without', collection: 'poetry', title: 'Morning, without it', author: 'Studio desk', provenance: ai, constraints: ['no-e'], text:
`Dawn spills its pink across a hill;
a crow calls out, and all is still.
Two cups of black java, toast with jam:
this is how mornings start. I am
too glad to talk.`},
  {key: 'gadsby', collection: 'poetry', title: 'Gadsby (opening)', author: 'Ernest Vincent Wright, 1939', provenance: pd, constraints: ['no-e'], text:
`If youth, throughout all history, had had a champion to stand up for it;
to show a doubting world that a child can think;
and, possibly, do it practically;
you wouldn't constantly run across folks today
who claim that "a child don't know anything."`},
  {key: 'tidal', collection: 'poetry', title: 'Tidal', author: 'Studio desk', provenance: ai, constraints: ['no-e', 'short'], text:
`salt and fog on a long gray bay,
a gull that drifts, a dog at play,
a child who digs a moat of sand
and calls it, proudly, his own land.`},
  {key: 'inventory', collection: 'poetry', title: 'Inventory', author: 'Studio desk', provenance: ai, constraints: ['no-e', 'short'], text:
`two coats, a hat, a box of string,
a radio that will not sing,
a pair of boots, still thick with mud,
a postcard from a town in flood.`},
  // ---- only o ----
  {key: 'monologue', collection: 'poetry', title: 'Bob', author: 'Studio desk', provenance: ai, constraints: ['only-o'], text:
`Bob sold lots of old clocks.
Tom's dog jogs on, nonstop,
lost from cold, from fog, from frost.
Mom's hot toddy? Lost.
Bob, forlorn, snorts: "Not now, Tom."`},
  {key: 'oslo', collection: 'poetry', title: 'Oslo', author: 'Studio desk', provenance: ai, constraints: ['only-o', 'short'], text:
`Lo! Long cold storms blow on Oslo.
Snow on rooftops, frost on doors;
folk who scoff now stop, slow, go.`},
  // ---- haiku ----
  {key: 'first-frost', collection: 'poetry', title: 'First frost', author: 'Studio desk', provenance: ai, constraints: ['haiku'], text:
`first frost on the porch
my breath writes a small white word
then takes it back home`},
  {key: 'kite', collection: 'poetry', title: 'Kite', author: 'Studio desk', provenance: ai, constraints: ['haiku'], text:
`salt wind in the pines
a kite tugs at a child's hand
both want the same sky`},
  {key: 'laundromat', collection: 'poetry', title: 'Laundromat', author: 'Studio desk', provenance: ai, constraints: ['haiku'], text:
`midnight laundromat
one sock circles in the drum
patient as the moon`},
  {key: 'old-dog', collection: 'poetry', title: 'Old dog', author: 'Studio desk', provenance: ai, constraints: ['haiku'], text:
`the old dog sleeps on
the warm square of afternoon
as the light moves off`},
  // ---- chain ----
  {key: 'rain-chain', collection: 'poetry', title: 'Rain chain', author: 'Studio desk', provenance: ai, constraints: ['chain', 'short'], text:
`the rain begins on the window
the window holds a gray street
the street empties of people
people carry the rain home`},
  {key: 'letters', collection: 'poetry', title: 'Letters', author: 'Studio desk', provenance: ai, constraints: ['chain'], text:
`I wrote you a letter in pencil
pencil fades faster than words
fades the way I meant it
meant to send it, never did`},
  {key: 'kitchen', collection: 'poetry', title: 'Kitchen', author: 'Studio desk', provenance: ai, constraints: ['chain'], text:
`my mother's kitchen smelled of bread
bread rising under a towel
towel stained with blackberry
blackberry jam on my fingers
fingers that still remember`},
  // ---- acrostics ----
  {key: 'boat', collection: 'poetry', title: 'A boat beneath a sunny sky', author: 'Lewis Carroll, 1871', provenance: pd, constraints: ['acrostic-alice'], text:
`A boat beneath a sunny sky,
Lingering onward dreamily
In an evening of July—

Children three that nestle near,
Eager eye and willing ear,
Pleased a simple tale to hear—

Long has paled that sunny sky:
Echoes fade and memories die:
Autumn frosts have slain July.

Still she haunts me, phantomwise,
Alice moving under skies
Never seen by waking eyes.

Children yet, the tale to hear,
Eager eye and willing ear,
Lovingly shall nestle near.

In a Wonderland they lie,
Dreaming as the days go by,
Dreaming as the summers die:

Ever drifting down the stream—
Lingering in the golden gleam—
Life, what is it but a dream?`},
  {key: 'elizabeth', collection: 'poetry', title: 'An acrostic', author: 'Edgar Allan Poe, 1829', provenance: pd, constraints: ['acrostic-elizabeth'], text:
`Elizabeth it is in vain you say
"Love not" — thou sayest it in so sweet a way:
In vain those words from thee or L.E.L.
Zantippe's talents had enforced so well:
Ah! if that language from thy heart arise,
Breath it less gently forth — and veil thine eyes.
Endymion, recollect, when Luna tried
To cure his love — was cured of all beside —
His follie — pride — and passion — for he died.`},
  {key: 'moon-acrostic', collection: 'poetry', title: 'Lot', author: 'Studio desk', provenance: ai, constraints: ['acrostic-moon', 'short'], text:
`Midnight hangs its lamp
Over the parking lot,
Over the sleeping cars,
Not asking anything.`},
  // ---- every word once ----
  {key: 'guests', collection: 'poetry', title: 'Guests', author: 'Studio desk', provenance: ai, constraints: ['once'], text:
`every word arrives only once,
like guests who never return:
so speak carefully, friend.
tonight's language burns.`},
  {key: 'ledger', collection: 'poetry', title: 'Ledger', author: 'Studio desk', provenance: ai, constraints: ['once', 'short'], text:
`rent paid. milk gone sour.
my brother called at noon,
asked if winter frightens me.
yes, said nobody. ask soon.`},

  // ---- the pressure chamber ----
  {key: 'c-bus', collection: 'chamber', title: 'Night bus', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`the night bus hums its one long vowel
past shuttered shops and a closed laundromat,
a driver, two nurses, and me.`},
  {key: 'c-quilt', collection: 'chamber', title: 'Quilt', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`my grandmother quilted squares of old shirts:
a plaid from a winter, a blue from a wedding,
and one quiet patch from a jacket she never explained.`},
  {key: 'c-jazz', collection: 'chamber', title: 'Jukebox', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`a jukebox in the back booth
plays the same jumpy song
we have all agreed to love.`},
  {key: 'c-fox', collection: 'chamber', title: 'Fox', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`a fox crossed the parking lot at six,
unhurried, like a neighbor with errands.`},
  {key: 'c-kettle', collection: 'chamber', title: 'Kettle', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`kettle on.
window fogged.
the cat
pretends
not to
care.`},
  {key: 'c-vigil', collection: 'chamber', title: 'Vigil', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`we kept the porch light on all night, just in case,
the way you leave a door unlocked for a dog
who has never once learned how to open it.`},
  {key: 'c-moth', collection: 'chamber', title: 'Moth', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`a moth
on the screen
all night
asking
for the
lamp`},
  {key: 'c-weekday', collection: 'chamber', title: 'Weekday', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`Monday wakes with a cough.
Tuesday borrows a pen and keeps it.
Wednesday is mostly hallway.
Thursday almost says what it means.
Friday leaves early, waving.
Saturday sleeps through it all.
Sunday irons a shirt for nobody.`},
  {key: 'c-hymn', collection: 'chamber', title: 'Small hymn', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`hold this
cup of
warm tea
for a
minute
longer`},
  {key: 'c-map', collection: 'chamber', title: 'Map', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`I folded the map wrong again
and now the whole coast of Oregon
runs straight through a crease in the ocean.`},
  {key: 'c-list', collection: 'chamber', title: 'Things the river took', author: 'Studio desk', provenance: ai, constraints: ['chamber-letters', 'chamber-width', 'chamber-length'], text:
`a canoe paddle
two sandals (one left, one also left)
my uncle's patience
the old footbridge
a whole summer of afternoons
the sound of my name across the water
a jar of pickled beets, somehow
the argument we were having
and the reason we were having it`},
  {key: 'c-zero', collection: 'chamber', title: 'Zero', author: 'Studio desk', provenance: ai, constraints: ['chamber-width', 'chamber-length'], text:
`the oven timer reaches zero
and nobody comes to the kitchen`},

  // ---- brand ----
  {key: 'b-launch', collection: 'brand', title: 'Product page: Harbor Blend', author: 'Northwind copy desk (fictional)', provenance: ai, constraints: ['brand-plain', 'brand-calm', 'brand-width'], text:
`Harbor Blend is our darkest roast: cocoa, burnt sugar, and a long, quiet finish.
Brew it strong in a French press, or let it carry milk in a flat white.
Roasted on Tuesdays, shipped on Wednesdays, at your door by the weekend.`},
  {key: 'b-newsletter', collection: 'brand', title: 'Newsletter: October', author: 'Northwind copy desk (fictional)', provenance: ai, constraints: ['brand-plain', 'brand-calm', 'brand-width'], text:
`October is the month we taste every new lot twice: once hot, once cooled to room temperature.
The cooled cup tells the truth. This month, three Colombian lots passed and one did not.
You will find the three in the shop from the 14th.`},
  {key: 'b-subscription', collection: 'brand', title: 'Subscription FAQ', author: 'Northwind copy desk (fictional)', provenance: ai, constraints: ['brand-plain', 'brand-calm', 'brand-width'], text:
`Can I pause my subscription? Yes, from your account page, for up to three months.
Can I change the grind? Yes, any time before Monday noon for that week's roast.
Do you ship outside the US? Not yet. We would rather get it right here first.`},
  {key: 'b-careers', collection: 'brand', title: 'Careers page', author: 'Northwind copy desk (fictional)', provenance: ai, constraints: ['brand-plain', 'brand-calm', 'brand-width'], text:
`We are hiring a roaster's assistant in Portland.
You will learn the machine, the logbook, and the smell of a batch about to go too far.
We pay from the first day of training, and we close at six.`},
  {key: 'b-cafe', collection: 'brand', title: 'Cafe chalkboard', author: 'Northwind copy desk (fictional)', provenance: ai, constraints: ['brand-plain', 'brand-calm', 'brand-width'], text:
`Today: Harbor Blend on drip, a washed Ethiopian on pour-over, and lemon cake until it runs out.
The best seat is by the window. It is usually taken.`},
  {key: 'b-sustain', collection: 'brand', title: 'Sourcing note', author: 'Northwind copy desk (fictional)', provenance: ai, constraints: ['brand-plain', 'brand-calm', 'brand-width'], text:
`We buy from eleven farms and visit each one at least every other year.
We publish what we paid per pound, including the years we paid less than we hoped to.
That page is boring on purpose. It should be.`},
  {key: 'b-wholesale', collection: 'brand', title: 'Wholesale pitch', author: 'Northwind copy desk (fictional)', provenance: ai, constraints: ['brand-plain', 'brand-calm', 'brand-width'], text:
`If you run a cafe, we will train your staff on our coffee for free, at your counter, on your machine.
We have done it for forty shops so far. The best results come from the shops that ask the most questions.`},
]
