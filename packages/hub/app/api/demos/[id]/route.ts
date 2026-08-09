import { NextResponse } from 'next/server'
import { getRecording, deleteRecording } from '@/lib/demo/recordings'
import { recordingStatus } from '@/lib/demo/recorder'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const r = getRecording(id)
    if (!r) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const { dir: _dir, ...rest } = r // don't leak the absolute path
    return NextResponse.json(rest)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}

// Permanently removes the recording folder — source clips, every rough-cut
// version, notes and master. There is no trash and no undo, so the confirmation
// lives in the UI and the "is it still recording" guard lives in the lib.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const st = recordingStatus()
    const activeId = st.recording ? st.dir : null
    const removed = deleteRecording(id, { activeId })
    return NextResponse.json({ ok: true, removed })
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 400
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status })
  }
}
