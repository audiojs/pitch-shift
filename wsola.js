import { bufferedStream, makePitchShift, resampleTo, resolvePitchParams } from './util.js'
import { wsolaStretch } from './stretch.js'

// Canonical WSOLA pitch shift: time-stretch the source by `ratio` (a longer signal
// at the same pitch) then resample the stretched buffer back to the original length.
// The per-frame similarity search keeps adjacent grains phase-aligned, which preserves
// periodic content without the modulation artifacts of a single-pass source-stride OLA.

function wsolaBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  let stretched = wsolaStretch(data, ratio, {
    frameSize: opts?.frameSize ?? 2048,
    hopSize: opts?.hopSize,
    delta: opts?.delta,
  })
  return resampleTo(stretched, data.length)
}

let wsolaStream = (opts) => bufferedStream(wsolaBatch, opts)

export default makePitchShift(wsolaBatch, wsolaStream)
