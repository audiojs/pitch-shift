import { stftBatch, stftStream } from './stft.js'
import { makePitchShift, resolvePitchParams, PI2 } from './util.js'

// Peak-match (not RMS-match) because the random-phase reconstruction is noise-like:
// its sample distribution is approximately Gaussian with peaks at ~3× RMS. Matching RMS
// to the input (which for a tone has RMS ≈ peak / √2) would push peaks to ~2× the input
// peak — audible clipping. Peak-match keeps the output within the input's dynamic range
// at the cost of a quieter RMS, which is the correct trade-off for a textural blurrer.
function matchPeak(out, ref) {
  let po = 0, pr = 0
  for (let i = 0; i < out.length; i++) { let v = out[i]; if (v < 0) v = -v; if (v > po) po = v }
  for (let i = 0; i < ref.length; i++) { let v = ref[i]; if (v < 0) v = -v; if (v > pr) pr = v }
  if (po < 1e-9 || pr < 1e-9) return out
  let g = pr / po
  for (let i = 0; i < out.length; i++) out[i] *= g
  return out
}

// Paulstretch-style pitch shift: large frames, phases randomized uniformly in [0, 2π),
// magnitudes gathered from source-bin k/ratio. Destroys temporal transients by design,
// producing the signature smooth, textural timbre — now shifted in pitch.

function makeProcess(ratio) {
  return function process(mag, phase, state, ctx) {
    let { half } = ctx
    let newMag = new Float64Array(half + 1)
    let newPhase = new Float64Array(half + 1)
    for (let k = 0; k <= half; k++) {
      let src = k / ratio
      if (src > half) continue
      let i = src | 0
      let f = src - i
      newMag[k] = mag[i] * (1 - f) + (i + 1 <= half ? mag[i + 1] : 0) * f
      newPhase[k] = Math.random() * PI2
    }
    return { mag: newMag, phase: newPhase }
  }
}

// Paulstretch's defining randomized phase means adjacent frames recombine incoherently,
// producing envelope modulation at the frame rate (sr / synHop). Push the frame rate below
// ~10 Hz — safely under the audible AM floor — by using very large frames and a 1/4 hop.
// At sr=44100 the 16 k/4 k pair gives ~10.8 Hz, inaudible as amplitude modulation.
function paulBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  let frameSize = opts?.frameSize ?? 16384
  let hopSize = opts?.hopSize ?? (frameSize >> 2)
  let out = stftBatch(data, makeProcess(ratio), { ...opts, ratio, frameSize, hopSize })
  return matchPeak(out, data)
}

function paulStream(opts) {
  let { ratio } = resolvePitchParams(opts)
  let frameSize = opts?.frameSize ?? 16384
  let hopSize = opts?.hopSize ?? (frameSize >> 2)
  let s = stftStream(makeProcess(ratio), { ...opts, ratio, frameSize, hopSize })
  return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
}

export default makePitchShift(paulBatch, paulStream)
