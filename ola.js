import { bufferedStream, makePitchShift, resampleTo, resolvePitchParams } from './util.js'
import { wsolaStretch } from './stretch.js'

// Overlap-Add pitch shift: time-stretch by `ratio` (OLA with a minimal similarity-lock
// window just large enough to keep pitched content in phase) then resample back to the
// original length. `delta = frameSize/16` is much lighter than wsola's frameSize/4, so
// the classical OLA character stays (audible graininess on busy material) while simple
// tones land on-pitch at their canonical amplitude — not 60% quieter and 38 Hz off.

function olaBatch(data, opts) {
  let frameSize = opts?.frameSize ?? 2048
  let { ratio } = resolvePitchParams(opts)
  let stretched = wsolaStretch(data, ratio, {
    frameSize,
    hopSize: opts?.hopSize,
    delta: opts?.delta ?? Math.max(16, frameSize >> 4),
  })
  return resampleTo(stretched, data.length)
}

let olaStream = (opts) => bufferedStream(olaBatch, opts)

export default makePitchShift(olaBatch, olaStream)
