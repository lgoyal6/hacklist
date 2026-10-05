import type {NextConfig} from 'next'

const config: NextConfig = {
  transpilePackages: ['@lipogram/checker', '@lipogram/engine'],
  outputFileTracingIncludes: {'/**': ['../seed/seed.ndjson']},
}
export default config
