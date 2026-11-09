import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { audioDir } from '../store'

/**
 * 녹음 파일을 OpenAI 음성 인식 API로 텍스트로 바꿉니다.
 * 녹음은 10분 단위 파일로 나뉘어 저장되므로(파일당 25MB 제한 대응) 순서대로 변환해 이어 붙입니다.
 */
export async function transcribeNoteAudio(noteId: string, apiKey: string, model: string): Promise<string> {
  if (!apiKey) throw new Error('설정에서 OpenAI API 키를 먼저 입력해 주세요.')
  const dir = audioDir(noteId)
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.webm')).sort()
  } catch {
    files = []
  }
  if (files.length === 0) throw new Error('변환할 녹음 파일이 없습니다.')

  const parts: string[] = []
  for (const f of files) {
    const buf = await fs.readFile(join(dir, f))
    const form = new FormData()
    form.append('file', new Blob([buf], { type: 'audio/webm' }), basename(f))
    form.append('model', model || 'whisper-1')
    form.append('language', 'ko')
    form.append('response_format', 'text')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    })
    if (!res.ok) {
      throw new Error(`음성 변환 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
    parts.push((await res.text()).trim())
  }
  return parts.join('\n\n')
}
