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

    // Peak-gated scatter. Canonical Bernsee scatters every source bin; but on chord material
    // the bins BETWEEN partials ("chimeras") have phase derivatives reporting non-stationary
    // intermediate frequencies — when scattered they produce an audible frame-rate soft click
    // on sustained chords. Fix: only scatter bins that are a local magnitude peak or an
    // immediate neighbour (±1). That's the set of bins whose phase derivative is reliably
    // reporting a real partial's true frequency; chimera bins between peaks are simply not
    // emitted. A ±1 neighbourhood (not ±2) preserves closely-spaced chord partials whose
    // mainlobes butt against each other — e.g. 275 and 330 Hz sit at bins 13 and 15 with
    // bin 14 between them; ±1 gates bin 14 out; ±2 would incorrectly swallow bin 15 itself.
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

      // Peak-neighbour test: bin k emits only if k, k-1, or k+1 is a local peak above floor.
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
