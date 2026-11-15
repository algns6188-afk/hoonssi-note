import { useRef, useState } from 'react'

/**
 * 초대 코드 입력칸.
 * 휴대폰 키보드가 한글·러시아어 상태여도 같은 자리의 영문 글자로 바꿔 줌.
 * (예: 한글 자판 ㅁ → A, ㅠ → B / 러시아어 자판 ф → A)
 */

// 한글 두벌식 자판 → 영문 자판
const KO: Record<string, string> = {
  ㅂ: 'Q', ㅈ: 'W', ㄷ: 'E', ㄱ: 'R', ㅅ: 'T', ㅛ: 'Y', ㅕ: 'U', ㅑ: 'I', ㅐ: 'O', ㅔ: 'P',
  ㅁ: 'A', ㄴ: 'S', ㅇ: 'D', ㄹ: 'F', ㅎ: 'G', ㅗ: 'H', ㅓ: 'J', ㅏ: 'K', ㅣ: 'L',
  ㅋ: 'Z', ㅌ: 'X', ㅊ: 'C', ㅍ: 'V', ㅠ: 'B', ㅜ: 'N', ㅡ: 'M',
  ㅃ: 'Q', ㅉ: 'W', ㄸ: 'E', ㄲ: 'R', ㅆ: 'T', ㅒ: 'O', ㅖ: 'P',
  ㅘ: 'HK', ㅙ: 'HO', ㅚ: 'HL', ㅝ: 'NJ', ㅞ: 'NP', ㅟ: 'NL', ㅢ: 'ML',
  ㄳ: 'RT', ㄵ: 'SW', ㄶ: 'SG', ㄺ: 'FR', ㄻ: 'FA', ㄼ: 'FQ', ㄽ: 'FT', ㄾ: 'FX', ㄿ: 'FV', ㅀ: 'FG', ㅄ: 'QT'
}
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
const JONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ']

// 러시아어 자판 → 영문 자판
const RU: Record<string, string> = {
  й: 'Q', ц: 'W', у: 'E', к: 'R', е: 'T', н: 'Y', г: 'U', ш: 'I', щ: 'O', з: 'P',
  ф: 'A', ы: 'S', в: 'D', а: 'F', п: 'G', р: 'H', о: 'J', л: 'K', д: 'L',
  я: 'Z', ч: 'X', с: 'C', м: 'V', и: 'B', т: 'N', ь: 'M'
}

/** 입력된 글자를 영문 대문자·숫자로. 바꿀 수 없는 글자가 있었는지도 알려줌 */
export function toCode(raw: string): { code: string; foreign: boolean } {
  let out = ''
  let foreign = false
  for (const ch of raw) {
    const c = ch.codePointAt(0)!
    if (/[a-z0-9]/i.test(ch)) out += ch.toUpperCase()
    else if (c >= 0xac00 && c <= 0xd7a3) {
      // 완성된 한글 글자(예: '므')를 자음·모음으로 나눠 자판 위치로
      const i = c - 0xac00
      const jamo = [CHO[Math.floor(i / 588)], JUNG[Math.floor((i % 588) / 28)], JONG[i % 28]]
      out += jamo.map((j) => (j ? KO[j] ?? '' : '')).join('')
    } else if (KO[ch]) out += KO[ch]
    else if (RU[ch.toLowerCase()]) out += RU[ch.toLowerCase()]
    else if (!/[\s\-_.]/.test(ch)) foreign = true
  }
  return { code: out, foreign }
}

export function CodeInput({ value, onChange, foreignHint }: {
  value: string
  onChange(v: string): void
  foreignHint: string
}): JSX.Element {
  const composing = useRef(false)
  const [shown, setShown] = useState<string | null>(null)
  const [foreign, setForeign] = useState(false)

  const apply = (raw: string): void => {
    const r = toCode(raw)
    setForeign(r.foreign)
    onChange(r.code.slice(0, 8))
    setShown(null)
  }

  return (
    <>
      <input
        className="code-input"
        value={shown ?? value}
        maxLength={24}
        autoCapitalize="characters"
        autoComplete="one-time-code"
        autoCorrect="off"
        spellCheck={false}
        lang="en"
        placeholder="ABCD2345"
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={(e) => {
          composing.current = false
          apply(e.currentTarget.value)
        }}
        onChange={(e) => {
          // 한글 조합 중에는 그대로 보여주고, 조합이 끝나면 영문으로 바꿈
          if (composing.current) setShown(e.target.value)
          else apply(e.target.value)
        }}
        onBlur={(e) => apply(e.currentTarget.value)}
      />
      {foreign && <span className="code-warn">⌨️ {foreignHint}</span>}
    </>
  )
}
