// Mono microphone input to S16LE at 8 kHz. Carry fractional sample time across renders.
class CameraPcm extends AudioWorkletProcessor {
  constructor() {
    super()
    this.phase = 0
    this.sum = 0
    this.count = 0
    this.samples = new Int16Array(1600)
    this.offset = 0
    this.energy = 0
  }
  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input) return true
    for (const v of input) {
      this.sum += v
      this.count++
      this.phase += 8000
      if (this.phase < sampleRate) continue
      this.phase -= sampleRate
      const value = Math.max(-1, Math.min(1, this.sum / this.count))
      this.energy += value * value
      this.samples[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767))
      this.sum = this.count = 0
      if (this.offset === this.samples.length) {
        const pcm = this.samples.buffer
        this.port.postMessage({ pcm, rms: Math.sqrt(this.energy / this.offset) }, [pcm])
        this.samples = new Int16Array(1600)
        this.offset = this.energy = 0
      }
    }
    return true
  }
}
registerProcessor('camera-pcm', CameraPcm)
