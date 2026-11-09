/**
 * 회의 녹음기.
 * - 마이크 + (선택) 시스템 소리(온라인 회의 상대방 목소리)를 섞어서 녹음
 * - 10분마다 파일을 끊어 저장 → 음성 인식 API의 파일 크기 제한(25MB)을 넘지 않음
 */
const SEGMENT_MS = 10 * 60 * 1000

export class MeetingRecorder {
  private streams: MediaStream[] = []
  private ctx: AudioContext | null = null
  private mixed: MediaStream | null = null
  private rec: MediaRecorder | null = null
  private segTimer: number | null = null
  private stopping = false
  private pending: Promise<void>[] = []

  constructor(
    private nextIndex: number,
    private onSegment: (index: number, data: ArrayBuffer) => Promise<void>
  ) {}

  async start(includeSystemAudio: boolean): Promise<{ systemAudio: boolean }> {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
    this.streams.push(mic)
    this.ctx = new AudioContext()
    const dest = this.ctx.createMediaStreamDestination()
    this.ctx.createMediaStreamSource(mic).connect(dest)

    let systemAudio = false
    if (includeSystemAudio) {
      try {
        const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
        disp.getVideoTracks().forEach((t) => t.stop())
        if (disp.getAudioTracks().length) {
          this.streams.push(disp)
          this.ctx.createMediaStreamSource(new MediaStream(disp.getAudioTracks())).connect(dest)
          systemAudio = true
        }
      } catch {
        // 시스템 소리 캡처를 지원하지 않는 환경이면 마이크만 녹음
      }
    }
    this.mixed = dest.stream
    this.startSegment()
    return { systemAudio }
  }

  private startSegment(): void {
    if (!this.mixed) return
    const chunks: Blob[] = []
    const rec = new MediaRecorder(this.mixed, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })
    const index = this.nextIndex++
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = () => {
      const p = new Blob(chunks, { type: 'audio/webm' }).arrayBuffer().then((buf) => this.onSegment(index, buf))
      this.pending.push(p)
      if (!this.stopping) this.startSegment()
    }
    rec.start(1000)
    this.rec = rec
    this.segTimer = window.setTimeout(() => rec.state !== 'inactive' && rec.stop(), SEGMENT_MS)
  }

  pause(): void {
    if (this.rec?.state === 'recording') this.rec.pause()
  }
  resume(): void {
    if (this.rec?.state === 'paused') this.rec.resume()
  }
  get paused(): boolean {
    return this.rec?.state === 'paused'
  }

  /** 녹음을 끝내고 모든 파일 저장이 끝날 때까지 기다립니다. 다음 파일 번호를 돌려줍니다. */
  async stop(): Promise<number> {
    this.stopping = true
    if (this.segTimer) window.clearTimeout(this.segTimer)
    if (this.rec && this.rec.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        this.rec!.addEventListener('stop', () => resolve(), { once: true })
        this.rec!.stop()
      })
    }
    await Promise.all(this.pending)
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    await this.ctx?.close()
    return this.nextIndex
  }
}
