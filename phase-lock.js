import { stftBatch, stftStream } from './stft.js'
import { findPeaks, nearestPeak, makeFrameRatio, matchGain, wrapPhase, makePitchShift, resolveRatio } from './util.js'

// Peak-locked phase vocoder (Laroche-Dolson style, adapted to direct bin-shift pitch shifting).
// Phase coherence across a region of influence is preserved by locking non-peak bins' phase
// relative to the nearest magnitude peak, rather than advancing every bin independently.

function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { half, hop, freqPerBin } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  if (!state.prev) {
    state.prev = new Float64Array(half + 1)
    state.syn = new Float64Array(half + 1)
    state.newMag = new Float64Array(half + 1)
    state.newPhase = new Float64Array(half + 1)
    state.peakDest = new Int32Array(half)
    state.peakSynPhase = new Float64Array(half)
    state.first = true
  }

  let { prev, syn, newMag, newPhase, peakDest, peakSynPhase } = state
  newMag.fill(0)
  newPhase.fill(0)
  let peaks = findPeaks(mag, half)

  for (let i = 0; i < peaks.length; i++) {
    let k = peaks[i]
    let trueFreq
    if (state.first) {
      trueFreq = k * freqPerBin
    } else {
      let dp = wrapPhase(phase[k] - prev[k] - k * freqPerBin * hop)
      trueFreq = k * freqPerBin + dp / hop
    }
    let shifted = trueFreq * ratio
    let destBin = Math.round(shifted / freqPerBin)
    if (destBin < 0 || destBin > half) {
      peakDest[i] = -1
      continue
    }
    let newSyn = wrapPhase(syn[destBin] + shifted * hop)
    peakDest[i] = destBin
    peakSynPhase[i] = newSyn
    syn[destBin] = newSyn
  }

  for (let k = 0; k <= half; k++) {
    let pi = nearestPeak(peaks, k)
    if (pi < 0) continue
    let pk = peaks[pi]
    let destBin = peakDest[pi]
    if (destBin < 0) continue
    let dest = destBin + (k - pk)
    if (dest < 0 || dest > half) continue
    let p = peakSynPhase[pi] + (phase[k] - phase[pk])
    if (mag[k] >= newMag[dest]) {
      newMag[dest] = mag[k]
      newPhase[dest] = p
    }
  }

  for (let k = 0; k <= half; k++) prev[k] = phase[k]
  state.first = false

  return { mag: newMag, phase: newPhase }
}

function phaseLockBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let out = stftBatch(data, process, { ...opts, ratio, ratioFn })
  return matchGain(out, data)
}

function phaseLockStream(opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let s = stftStream(process, { ...opts, ratio, ratioFn })
  return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
}

export default makePitchShift(phaseLockBatch, phaseLockStream)
