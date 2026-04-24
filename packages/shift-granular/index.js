import { wsola as stretch } from 'time-stretch'
import { bufferedStream, makePitchShift, resampleTo, resolvePitchParams } from '@audio/shift-core'

// Granular pitch shift. Same stretch+resample form as `ola` — WSOLA time-stretch with
// similarity search followed by anti-aliased sinc resample — but with small grains
// (1024 by default) so the grain rate is clearly audible. The characteristic granular
// texture *is* the point: the artifacts that `ola` minimises with large frames are here
// intentionally amplified, turning the grain rate into a signature sound.
function granularBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  let frameSize = opts?.frameSize ?? 1024
  let hopSize = opts?.hopSize ?? (frameSize >> 2)
  let stretched = stretch(data, { factor: ratio, frameSize, hopSize })
  return resampleTo(stretched, data.length)
}

let granularStream = (opts) => bufferedStream(granularBatch, opts)

export default makePitchShift(granularBatch, granularStream)
