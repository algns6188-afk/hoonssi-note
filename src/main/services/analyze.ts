import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import type { MeetingAnalysis } from '../../shared/types'

const AnalysisSchema = z.object({
  title: z.string().describe('회의 내용을 대표하는 짧은 제목'),
  summary: z.string().describe('3~5문장 요약'),
  keyPoints: z.array(z.string()).describe('주요 논의 내용'),
  decisions: z.array(z.string()).describe('확정된 결정 사항'),
  actionItems: z
    .array(
      z.object({
        task: z.string(),
        owner: z.string().nullable().describe('담당자 이름. 언급이 없으면 null'),
        due: z.string().nullable().describe('기한. YYYY-MM-DD 로 확정 가능하면 그 형식, 아니면 언급된 표현 그대로, 없으면 null')
      })
    )
    .describe('해야 할 일'),
  openIssues: z.array(z.string()).describe('결론이 나지 않은 사안'),
  risks: z.array(z.string()).describe('일정·비용·품질 등 우려되는 점'),
  nextAgenda: z.array(z.string()).describe('다음 회의에서 다룰 안건')
})

const SYSTEM = `당신은 한국 회사의 회의록을 정리하는 비서입니다.
회의 녹취록을 읽고 업무에 바로 쓸 수 있게 정리합니다.
- 녹취록에 없는 내용은 지어내지 않습니다. 해당 항목이 없으면 빈 배열로 둡니다.
- 음성 인식 오류로 보이는 단어는 문맥에 맞게 바로잡되, 의미를 바꾸지 않습니다.
- 모든 결과는 자연스러운 한국어 업무 문체(~함, ~예정)로 씁니다.`

export async function analyzeMeeting(opts: {
  apiKey: string
  transcript: string
  participants: string[]
  meetingDate: string
  memo: string
}): Promise<MeetingAnalysis> {
  if (!opts.apiKey) throw new Error('설정에서 Anthropic(Claude) API 키를 먼저 입력해 주세요.')
  if (!opts.transcript.trim()) throw new Error('분석할 녹취록이 없습니다. 먼저 텍스트 변환을 해 주세요.')

  const client = new Anthropic({ apiKey: opts.apiKey })
  const userText = [
    `회의 날짜: ${opts.meetingDate}`,
    `참석자: ${opts.participants.join(', ') || '(입력 없음)'}`,
    opts.memo.trim() ? `작성자 메모:\n${opts.memo.trim()}` : '',
    `녹취록:\n<transcript>\n${opts.transcript}\n</transcript>`
  ]
    .filter(Boolean)
    .join('\n\n')

  const response = await client.beta.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: betaZodOutputFormat(AnalysisSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: userText }]
  })

  if (response.stop_reason === 'refusal') {
    throw new Error('AI가 이 내용의 분석을 거절했습니다. 녹취록 내용을 확인해 주세요.')
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('회의가 너무 길어 분석 결과가 잘렸습니다.')
  }
  if (!response.parsed_output) throw new Error('분석 결과를 읽지 못했습니다. 다시 시도해 주세요.')
  return response.parsed_output
}
