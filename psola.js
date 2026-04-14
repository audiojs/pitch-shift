import { bufferedStream, makePitchShift, resampleTo, resolvePitchParams } from './util.js'
import { psolaStretch } from './stretch.js'

// Pitch-Synchronous Overlap-Add pitch shift. Canonical two-stage form: PSOLA time-stretch
// by `ratio` (pitch-mark-driven grain placement keeps cycles coherent), then linear
// resample back to the original length. The stretcher falls back to WSOLA on unvoiced
// or weakly-voiced material, so complex / polyphonic input still produces clean output
// instead of the buzzing you get from naive single-pass TD-PSOLA.

function psolaBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  let stretched = psolaStretch(data, ratio, {
    sampleRate: opts?.sampleRate,
    minFreq: opts?.minFreq,
    maxFreq: opts?.maxFreq,
    frameSize: opts?.frameSize,
    hopSize: opts?.hopSize,
  })
  return resampleTo(stretched, data.length)
}

let psolaStream = (opts) => bufferedStream(psolaBatch, opts)

export default makePitchShift(psolaBatch, psolaStream)
