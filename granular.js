import { bufferedStream, makePitchShift, resampleTo, resolvePitchParams } from './util.js'
import { wsolaStretch } from './stretch.js'

// Granular pitch shift: small (1024-sample) Hann-windowed grains OLA-stretched with a
// minimal similarity-lock window so tonal material stays audible and on-pitch. Distinct
// from wsola in that the grains are half the size — the classic "granular synthesis"
// grainy character on busy material, without the catastrophic dropout that pure OLA
// (delta=0) suffers on chord/voice input.

function granularBatch(data, opts) {
  let frameSize = opts?.frameSize ?? 1024
  let { ratio } = resolvePitchParams(opts)
  let stretched = wsolaStretch(data, ratio, {
    frameSize,
    hopSize: opts?.hopSize,
    delta: opts?.delta ?? Math.max(16, frameSize >> 3),
  })
  return resampleTo(stretched, data.length)
}

let granularStream = (opts) => bufferedStream(granularBatch, opts)

export default makePitchShift(granularBatch, granularStream)
