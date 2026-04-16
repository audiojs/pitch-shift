import { psola as stretch } from 'time-stretch'
import { bufferedStream, makePitchShift, resampleTo, resolvePitchParams } from './util.js'

// Canonical Pitch-Synchronous Overlap-Add pitch shift (Moulines-Charpentier 1990).
// PSOLA time-stretch at `factor = ratio` — autocorrelation period contour → pitch marks
// → two-period Hann grains placed at pitch-synchronous intervals, preserving the
// vocal-tract filter (formants) by construction — followed by anti-aliased sinc resample
// back to original length. Designed for monophonic voiced material; polyphonic input
// violates the single-pitch assumption.
function psolaBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  let sr = opts?.sampleRate || 44100
  let stretched = stretch(data, {
    factor: ratio,
    sampleRate: sr,
    minFreq: opts?.minFreq,
    maxFreq: opts?.maxFreq,
  })
  return resampleTo(stretched, data.length)
}

let psolaStream = (opts) => bufferedStream(psolaBatch, opts)

export default makePitchShift(psolaBatch, psolaStream)
