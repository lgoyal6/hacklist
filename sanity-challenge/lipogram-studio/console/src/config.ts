// Sanity's build replaces SANITY_APP_* variables at build time.
const env: Record<string, string | undefined> =
  (import.meta as any).env ?? (typeof process !== 'undefined' ? (process.env as any) : {})

export const PROJECT_ID = env.SANITY_APP_PROJECT_ID ?? 'your-project-id'
export const DATASET = 'production'
export const ENGINE_DATASET = 'workflows'
export const WORKFLOW_TAG = 'prod'
