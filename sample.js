import { bufferedStream, makePitchShift, resolveRatio } from './util.js'
import { wsolaStretch } from './stretch.js'

// Sample-based pitch shift with a sinc playback interpolator. Duration is preserved
// the classical way: first time-stretch the source (WSOLA) by `ratio` so content fills
// the equivalent intended duration, then a Hann-windowed sinc interpolator "plays back"
// the stretched buffer at rate `ratio` to land on exactly `data.length` output samples.
// Identical in spirit to a hardware sampler with a rubber band under the tape: higher
// pitch = faster tape = stretched source compensates so total duration stays the same.

function sincInterp(buf, relPos, r) {
  let bufLen = buf.length
  let i0 = Math.floor(relPos)
  let frac = relPos - i0
  let s = 0
  for (let k = -r + 1; k <= r; k++) {
    let idx = i0 + k
    if (idx < 0 || idx >= bufLen) continue
    let x = k - frac
    let a = Math.abs(x) / r
    if (a >= 1) continue
    let si = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    let w = 0.5 + 0.5 * Math.cos(Math.PI * a)
    s += buf[idx] * si * w
  }
  return s
}

function sampleBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  if (ratio === 1 && !ratioFn) return new Float32Array(data)
  let r = opts?.sincRadius ?? 8
  let sr = opts?.sampleRate || 44100
  let n = data.length
  let out = new Float32Array(n)
  // Time-stretch source by ratio so we have enough content to feed a rate-ratio playback
  // for the full output length. For constant ratio this gives stretchedLen ≈ n*ratio and
  // readPos = i*ratio lands inside the stretched buffer for every i.
  let stretchFactor = ratioFn ? null : ratio
  let stretched = stretchFactor
    ? wsolaStretch(data, stretchFactor, { frameSize: opts?.frameSize ?? 2048, hopSize: opts?.hopSize })
    : data
  let readPos = 0
  for (let i = 0; i < n; i++) {
    let rNow = ratioFn ? ratioFn(i / sr) : ratio
    out[i] = sincInterp(stretched, readPos, r)
    readPos += rNow
    if (readPos + r >= stretched.length) {
      // Variable ratio path: if we run past the end, zero-pad the tail rather than loop.
      for (let j = i + 1; j < n; j++) out[j] = 0
      break
    }
  }
  return out
}

let sampleStream = (opts) => bufferedStream(sampleBatch, opts)

export default makePitchShift(sampleBatch, sampleStream)
