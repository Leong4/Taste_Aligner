export type PlannerCard = {
  step: number
  place: string
}

export type PlannerOutput = {
  dummy?: boolean
  city?: string
  cz_used?: string[]
  ez_used?: string[]
  cards?: PlannerCard[]
}

export type RunResponse = {
  ok: boolean
  city: string | null
  type: 'food' | 'culture' | 'mixed' | 'unknown'
  tool: string | null
  output: PlannerOutput | null
  observation: unknown | null
  history?: unknown[]
}
