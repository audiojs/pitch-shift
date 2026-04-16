import { wsola as stretch } from 'time-stretch'
import { bufferedStream, makePitchShift, resampleTo, resolvePitchParams } from './util.js'

// Overlap-Add pitch shift (Flanagan-Golden). WSOLA time-stretch at `factor = ratio`
// with a moderate similarity search to prevent grain-rate phase cancellation, followed
// by anti-aliased sinc resample back to original length. The simplest practical
// stretch+resample pitch shift — the baseline the others improve on.
function olaBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  let frameSize = opts?.frameSize ?? 2048
  let hopSize = opts?.hopSize ?? (frameSize >> 2)
  let stretched = stretch(data, { factor: ratio, frameSize, hopSize })
  return resampleTo(stretched, data.length)
}

let olaStream = (opts) => bufferedStream(olaBatch, opts)

export default makePitchShift(olaBatch, olaStream)
