import type { Channel, Note, Settings } from '../../shared/types'

export const CHANNEL_LABEL: Record<Channel, string> = { slack: 'Slack', teams: 'MS Teams', kakao: '카카오톡' }

const bullet = (items: string[]): string => (items.length ? items.map((s) => `• ${s}`).join('\n') : '• 없음')

/** 회의 결과를 메신저에 보낼 일반 텍스트로 만듭니다. */
export function formatMeetingText(note: Note): string {
  const a = note.meeting?.analysis
  if (!a) throw new Error('먼저 AI 분석을 실행해 주세요.')
  const date = note.createdAt.slice(0, 10)
  const actions = a.actionItems.length
    ? a.actionItems.map((x) => `• ${x.task}${x.owner ? ` — ${x.owner}` : ''}${x.due ? ` (~${x.due})` : ''}`).join('\n')
    : '• 없음'
  return [
    `[훈씨노트] ${note.title || a.title} (${date})`,
    note.meeting?.participants.length ? `참석: ${note.meeting.participants.join(', ')}` : '',
    '',
    `■ 요약\n${a.summary}`,
    '',
    `■ 결정 사항\n${bullet(a.decisions)}`,
    '',
    `■ 할 일\n${actions}`,
    a.openIssues.length ? `\n■ 미결 사항\n${bullet(a.openIssues)}` : '',
    a.nextAgenda.length ? `\n■ 다음 회의 안건\n${bullet(a.nextAgenda)}` : ''
  ]
    .filter((l) => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

async function check(res: Response, name: string): Promise<void> {
  if (!res.ok) throw new Error(`${name} 전송 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`)
}

async function sendSlack(webhook: string, text: string): Promise<void> {
  if (!webhook) throw new Error('설정에서 Slack 웹훅 주소를 입력해 주세요.')
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
  await check(res, 'Slack')
}

/** Teams 의 "웹훅 요청을 받으면 채널에 게시" 워크플로 주소로 Adaptive Card 를 보냅니다. */
async function sendTeams(webhook: string, text: string): Promise<void> {
  if (!webhook) throw new Error('설정에서 Teams 웹훅 주소를 입력해 주세요.')
  const [title, ...rest] = text.split('\n')
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
              { type: 'TextBlock', text: rest.join('\n\n').replace(/\n\n\n+/g, '\n\n'), wrap: true }
            ]
          }
        }
      ]
    })
  })
  await check(res, 'Teams')
}

/**
 * 카카오톡 "나에게 보내기" API. 기본 텍스트 템플릿은 200자 제한이 있어
 * 요약과 할 일 위주로 줄여서 보냅니다. 팀원 여러 명에게 보내려면
 * 카카오 비즈니스 채널(알림톡) 연동이 필요합니다 (다음 단계).
 */
async function sendKakao(token: string, note: Note): Promise<void> {
  if (!token) throw new Error('설정에서 카카오 액세스 토큰을 입력해 주세요.')
  const a = note.meeting!.analysis!
  let text = `[훈씨노트] ${note.title || a.title}\n${a.summary}\n할 일 ${a.actionItems.length}건`
  if (text.length > 200) text = text.slice(0, 197) + '...'
  const body = new URLSearchParams({
    template_object: JSON.stringify({ object_type: 'text', text, link: {} })
  })
  const res = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body
  })
  await check(res, '카카오톡')
}

export async function sendToChannel(channel: Channel, settings: Settings, note: Note): Promise<void> {
  const text = formatMeetingText(note)
  if (channel === 'slack') return sendSlack(settings.slackWebhook, text)
  if (channel === 'teams') return sendTeams(settings.teamsWebhook, text)
  return sendKakao(settings.kakaoAccessToken, note)
}

/** 설정 화면의 "테스트 전송" 버튼용 */
export async function sendTest(channel: Channel, settings: Settings): Promise<void> {
  const msg = '[훈씨노트] 연동 테스트 메시지입니다. ✅'
  if (channel === 'slack') return sendSlack(settings.slackWebhook, msg)
  if (channel === 'teams') return sendTeams(settings.teamsWebhook, msg)
  if (!settings.kakaoAccessToken) throw new Error('설정에서 카카오 액세스 토큰을 입력해 주세요.')
  const res = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.kakaoAccessToken}` },
    body: new URLSearchParams({ template_object: JSON.stringify({ object_type: 'text', text: msg, link: {} }) })
  })
  await check(res, '카카오톡')
}
