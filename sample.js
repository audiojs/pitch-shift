import { bufferedStream, makePitchShift, resolveRatio } from './util.js'
import { wsolaStretch } from './stretch.js'

// Sample-based pitch shift with a sinc playback interpolator. Duration is preserved
// the classical way: first time-stretch the source (WSOLA) by `ratio` so content fills
// the equivalent intended duration, then a Hann-windowed sinc interpolator "plays back"
// the stretched buffer at rate `ratio` to land on exactly `data.length` output samples.
// Identical in spirit to a hardware sampler with a rubber band under the tape: higher
// pitch = faster tape = stretched source compensates so total duration stays the same.

// cutoff ∈ (0,1]: anti-alias lowpass at cutoff × Nyquist. hw = ceil(r/cutoff) widens the
// kernel to maintain the same number of zero-crossings when cutoff < 1.
function sincInterp(buf, relPos, r, cutoff) {
  let bufLen = buf.length
  let i0 = Math.floor(relPos)
  let frac = relPos - i0
  let hw = Math.ceil(r / cutoff)
  let s = 0
  for (let k = -hw + 1; k <= hw; k++) {
    let idx = i0 + k
    if (idx < 0 || idx >= bufLen) continue
    let x = k - frac
    let xi = x * cutoff
    let wi = Math.abs(x) / hw
    if (wi >= 1) continue
    let si = Math.abs(xi) < 1e-9 ? 1 : Math.sin(Math.PI * xi) / (Math.PI * xi)
    let w = 0.5 + 0.5 * Math.cos(Math.PI * wi)
    s += buf[idx] * si * cutoff * w
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
  // When stepping faster than 1 sample per output (ratio > 1), apply anti-alias lowpass
  // at 1/ratio so content above Nyquist/ratio is suppressed before it folds.
  let cutoff = ratio > 1 ? 1 / ratio : 1
  let hw = Math.ceil(r / cutoff)
  let readPos = 0
  for (let i = 0; i < n; i++) {
    let rNow = ratioFn ? ratioFn(i / sr) : ratio
    let cNow = ratioFn ? (rNow > 1 ? 1 / rNow : 1) : cutoff
    let hwNow = ratioFn ? Math.ceil(r / cNow) : hw
    out[i] = sincInterp(stretched, readPos, r, cNow)
    readPos += rNow
    if (readPos + hwNow >= stretched.length) {
      for (let j = i + 1; j < n; j++) out[j] = 0
      break
    }
  }
  return out
}

let sampleStream = (opts) => bufferedStream(sampleBatch, opts)

export default makePitchShift(sampleBatch, sampleStream)
