'use client'

// Build the RunRequest a start ingress requires (A1b.1).
//
// The hub carries NO authority here: everything in this request is re-verified
// server-side at admission time (repo against the project's origin, head
// against the actual current head, task packet against the committed tree at
// that head, nonce against the durable replay store). This helper only saves
// the user from hand-writing the envelope. GET /api/admission/context is a
// pure read; if the head moves between that read and the start, admission
// refuses with ADMISSION_HEAD_STALE and the caller re-reads.

export interface RunRequest {
  version: number
  repo: string
  head: string
  task_packet: string
  claims: unknown[]
  issued_at: string
  expires_at: string
  nonce: string
}

interface AdmissionContext {
  version?: number
  maxValiditySeconds?: number
  repo?: string
  head?: string
  taskPacket?: string | null
  taskPacketError?: string
  error?: string
}

/** Five minutes — well inside the server's documented maximum validity. */
const VALIDITY_MS = 5 * 60 * 1000

function makeNonce(): string {
  try {
    return crypto.randomUUID()
  } catch {
    // Older WebViews: 32 hex chars of Math.random-derived entropy. Uniqueness,
    // not secrecy, is what the nonce needs — replay protection is server-side.
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  }
}

/**
 * Fetch the admission context and assemble a RunRequest for a run start.
 * Returns { runRequest } or { error } with the server's reason.
 */
export async function buildRunRequest(
  get: (path: string) => Promise<AdmissionContext>,
  opts: { type?: string; input?: string }
): Promise<{ runRequest?: RunRequest; error?: string }> {
  let ctx: AdmissionContext
  try {
    const params = new URLSearchParams()
    if (opts.type) params.set('type', opts.type)
    if (opts.input) params.set('input', opts.input)
    ctx = await get(`/admission/context?${params.toString()}`)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not read the admission context' }
  }
  if (!ctx || ctx.error) return { error: ctx?.error || 'Could not read the admission context' }
  if (!ctx.repo || !ctx.head) return { error: 'Admission context did not include the repo and head' }
  if (!ctx.taskPacket) {
    return { error: ctx.taskPacketError || 'No task packet could be resolved for this start — commit the spec it runs against first' }
  }
  const now = Date.now()
  return {
    runRequest: {
      version: ctx.version ?? 1,
      repo: ctx.repo,
      head: ctx.head,
      task_packet: ctx.taskPacket,
      claims: [],
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + VALIDITY_MS).toISOString(),
      nonce: makeNonce(),
    },
  }
}
