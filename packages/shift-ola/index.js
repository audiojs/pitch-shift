import { wsola as stretch } from 'time-stretch'
import { bufferedStream, makePitchShift, resampleTo, resolvePitchParams } from '@audio/shift-core'

// Overlap-Add pitch shift (Flanagan-Golden 1966). Plain OLA time-stretch at `factor =
// ratio` — no similarity search (delta=0), so grains are placed at nominal analysis
// positions — followed by anti-aliased sinc resample back to original length. The
// simplest stretch+resample pitch shift — the baseline the others improve on. For the
// same form with per-grain similarity search, use `wsola`.
function olaBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  let frameSize = opts?.frameSize ?? 2048
  let hopSize = opts?.hopSize ?? (frameSize >> 2)
  let stretched = stretch(data, { factor: ratio, frameSize, hopSize, delta: 0 })
  return resampleTo(stretched, data.length)
}

let olaStream = (opts) => bufferedStream(olaBatch, opts)

export default makePitchShift(olaBatch, olaStream)
