import { stftBatch, stftStream } from './stft.js'
import { matchGain, wrapPhase, makePitchShift, resolvePitchParams } from './util.js'

// Canonical phase vocoder pitch shift (Bernsee / SMB method).
// Per frame: compute true instantaneous frequency at each analysis bin, shift each bin's
// contribution to a new bin position determined by that frequency × ratio, and accumulate
// synthesis phase at the shifted frequency. No time-stretch, no resample.
function makeProcess(ratio) {
  return function process(mag, phase, state, ctx) {
    let { half, hop, freqPerBin } = ctx
    if (!state.prev) {
      state.prev = new Float64Array(half + 1)
      state.syn = new Float64Array(half + 1)
      state.newMag = new Float64Array(half + 1)
      state.newFreq = new Float64Array(half + 1)
      state.first = true
    }

    let prev = state.prev
    let syn = state.syn
    let newMag = state.newMag
    let newFreq = state.newFreq
    newMag.fill(0)
    newFreq.fill(0)

    // Peak-gated scatter. Only bins at or adjacent (±1) to a local magnitude peak are
    // eligible — chimera bins between partials have unreliable phase derivatives that
    // produce frame-rate clicks on chords. ±1 neighbourhood preserves closely-spaced
    // partials (e.g. 275/330 Hz at bins 13/15 — bin 14 is gated out, ±2 would swallow 15).
    let maxM = 0
    for (let k = 0; k <= half; k++) if (mag[k] > maxM) maxM = mag[k]
    let floor = Math.max(1e-8, maxM * 0.005)

    for (let k = 0; k <= half; k++) {
      let trueFreq
      if (state.first) {
        trueFreq = k * freqPerBin
      } else {
        let dp = wrapPhase(phase[k] - prev[k] - k * freqPerBin * hop)
        trueFreq = k * freqPerBin + dp / hop
      }
      prev[k] = phase[k]

      let isEligible = false
      for (let d = -1; d <= 1; d++) {
        let j = k + d
        if (j <= 0 || j >= half) continue
        if (mag[j] >= floor && mag[j] > mag[j - 1] && mag[j] > mag[j + 1]) { isEligible = true; break }
      }
      if (!isEligible) continue

      let shifted = trueFreq * ratio
      let destBin = Math.round(shifted / freqPerBin)
      if (destBin < 0 || destBin > half) continue
      if (mag[k] > newMag[destBin]) {
        newMag[destBin] = mag[k]
        newFreq[destBin] = shifted
      }
    }

    for (let k = 0; k <= half; k++) {
      syn[k] = wrapPhase(syn[k] + newFreq[k] * hop)
    }

    state.first = false
    return { mag: newMag, phase: syn }
  }
}

function vocoderBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  let out = stftBatch(data, makeProcess(ratio), { ...opts, ratio })
  return matchGain(out, data)
}

function vocoderStream(opts) {
  let { ratio } = resolvePitchParams(opts)
  let s = stftStream(makeProcess(ratio), { ...opts, ratio })
  return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
}

export default makePitchShift(vocoderBatch, vocoderStream)
