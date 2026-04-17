import { stftBatch, stftStream } from './stft.js'
import { findPeaks, nearestPeak, makeFrameRatio, matchGain, wrapPhase, makePitchShift, resolveRatio } from './util.js'

// Transient-aware phase vocoder pitch shift.
// On detected transient frames, phase is reset to the analysis phase (vertical coherence is
// preferred over horizontal on these frames), which keeps attacks sharp. Between transients
// it behaves like a peak-locked vocoder.

function makeProcess(ratio, threshold) {
  let fr = makeFrameRatio(ratio)
  return function process(mag, phase, state, ctx) {
    let { half, hop, freqPerBin } = ctx
    let ratio = fr.at(ctx.frameStart, ctx.sampleRate)
    if (!state.prev) {
      state.prev = new Float64Array(half + 1)
      state.prevMag = new Float64Array(half + 1)
      state.syn = new Float64Array(half + 1)
      state.newMag = new Float64Array(half + 1)
      state.newPhase = new Float64Array(half + 1)
      state.peakDest = new Int32Array(half)
      state.peakSynPhase = new Float64Array(half)
      state.fluxMean = 0
      state.fluxVar = 0
      state.frames = 0
      state.first = true
    }

    let { prev, prevMag, syn, newMag, newPhase, peakDest, peakSynPhase } = state
    newMag.fill(0)
    newPhase.fill(0)

    // Spectral flux (Hf difference, positive only, log-compressed).
    let flux = 0, energy = 0
    if (!state.first) {
      for (let k = 0; k <= half; k++) {
        let d = Math.log1p(mag[k]) - Math.log1p(prevMag[k])
        if (d > 0) flux += d
        energy += Math.log1p(mag[k])
      }
    }
    let nFlux = energy > 1e-10 ? flux / energy : 0
    let std = Math.sqrt(state.fluxVar)
    // Absolute floor on the detection margin so sustained polyphonic material (where
    // partial beating drives tiny periodic flux fluctuations) never crosses the threshold.
    // Attack flux on a plucked/struck signal is 0.3–1.0 in these units, so an 0.08 floor
    // with multiplier 1.5 still fires on real transients but ignores beating noise.
    let isTransient = state.frames > 3 && nFlux > state.fluxMean + threshold * Math.max(0.08, std)

    // Update running flux stats (EMA mean + variance).
    let alpha = isTransient ? 0.25 : 0.1
    let delta = nFlux - state.fluxMean
    state.fluxMean += alpha * delta
    state.fluxVar = (1 - alpha) * (state.fluxVar + alpha * delta * delta)

    let peaks = findPeaks(mag, half)

    for (let i = 0; i < peaks.length; i++) {
      let k = peaks[i]
      let trueFreq
      if (state.first || isTransient) {
        trueFreq = k * freqPerBin
      } else {
        let dp = wrapPhase(phase[k] - prev[k] - k * freqPerBin * hop)
        trueFreq = k * freqPerBin + dp / hop
      }
      let shifted = trueFreq * ratio
      let destBin = Math.round(shifted / freqPerBin)
      if (destBin < 0 || destBin > half) { peakDest[i] = -1; continue }
      let newSyn = isTransient ? phase[k] : wrapPhase(syn[destBin] + shifted * hop)
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

    for (let k = 0; k <= half; k++) {
      prev[k] = phase[k]
      prevMag[k] = mag[k]
    }
    state.first = false
    state.frames++

    return { mag: newMag, phase: newPhase }
  }
}

function transientBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let threshold = opts?.transientThreshold ?? 1.5
  let out = stftBatch(data, makeProcess(ratioFn || ratio, threshold), { ...opts, ratio, ratioFn })
  return matchGain(out, data)
}

function transientStream(opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let threshold = opts?.transientThreshold ?? 1.5
  let s = stftStream(makeProcess(ratioFn || ratio, threshold), { ...opts, ratio, ratioFn })
  return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
}

export default makePitchShift(transientBatch, transientStream)
