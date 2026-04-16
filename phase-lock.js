import { stftBatch, stftStream } from './stft.js'
import { matchGain, wrapPhase, makePitchShift, resolveRatio } from './util.js'

// Peak-locked phase vocoder (Laroche-Dolson style, adapted to direct bin-shift pitch shifting).
// Phase coherence across a region of influence is preserved by locking non-peak bins' phase
// relative to the nearest magnitude peak, rather than advancing every bin independently.

function findPeaks(mag, half) {
  // First-order local maxima above a fraction of the frame's peak. A strict ±2 comparison
  // (classic Laroche-Dolson) drops the weaker of two closely-spaced chord partials whose
  // mainlobes overlap — e.g. 275 and 330 Hz at N=2048 share bins 13 and 15 with bin 14 in
  // between. ±2 keeps only bin 13 and orphans bin 15's energy into bin 13's region of
  // influence, producing a wrong shifted frequency for the third partial. ±1 recovers it.
  let maxM = 0
  for (let k = 0; k <= half; k++) if (mag[k] > maxM) maxM = mag[k]
  let floor = Math.max(1e-8, maxM * 0.005)
  let peaks = []
  for (let k = 1; k < half; k++) {
    let v = mag[k]
    if (v < floor) continue
    if (v > mag[k - 1] && v > mag[k + 1]) peaks.push(k)
  }
  return peaks
}

function makeProcess(ratio) {
  let ratioFn = typeof ratio === 'function' ? ratio : null
  let scalar = ratioFn ? ratioFn(0) : ratio
  return function process(mag, phase, state, ctx) {
    let { half, hop, freqPerBin, sampleRate, frameStart } = ctx
    let ratio = ratioFn ? ratioFn(Math.max(0, frameStart) / sampleRate) : scalar
    if (!Number.isFinite(ratio) || ratio <= 0) ratio = scalar || 1
    if (!state.prev) {
      state.prev = new Float64Array(half + 1)
      state.syn = new Float64Array(half + 1)
      state.first = true
    }

    let prev = state.prev
    let syn = state.syn
    let peaks = findPeaks(mag, half)
    let newMag = new Float64Array(half + 1)
    let newPhase = new Float64Array(half + 1)

    // Process peaks: compute true freq, shift, update phase.
    let peakDest = new Int32Array(peaks.length)
    let peakSynPhase = new Float64Array(peaks.length)

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
      // Synthesis phase accumulator indexed by source peak bin — for sustained tones
      // source peaks are stable across frames, so horizontal phase propagation is stable.
      let newSyn = wrapPhase(syn[k] + shifted * hop)
      peakDest[i] = destBin
      peakSynPhase[i] = newSyn
      syn[k] = newSyn
    }

    // Define region of influence: bins between adjacent peaks belong to the nearest peak.
    // Scatter each source bin to its destination, preserving the peak's phase relationship.
    let assigned = (k) => {
      if (!peaks.length) return -1
      let lo = 0, hi = peaks.length - 1
      while (lo < hi) {
        let mid = (lo + hi) >> 1
        if (peaks[mid] < k) lo = mid + 1
        else hi = mid
      }
      // Bisect to nearest
      if (lo > 0 && Math.abs(peaks[lo - 1] - k) <= Math.abs(peaks[lo] - k)) return lo - 1
      return lo
    }

    for (let k = 0; k <= half; k++) {
      let pi = assigned(k)
      if (pi < 0) continue
      let pk = peaks[pi]
      let destBin = peakDest[pi]
      if (destBin < 0) continue
      // Dest bin for non-peak = peak dest + offset from peak
      let offset = k - pk
      let dest = destBin + offset
      if (dest < 0 || dest > half) continue
      // Phase offset from peak is preserved: origPhaseOffset = phase[k] - phase[pk]
      // new phase = peakSynPhase[pi] + origPhaseOffset
      let origOffset = phase[k] - phase[pk]
      let p = peakSynPhase[pi] + origOffset
      // Take the strongest contribution at each dest bin.
      if (mag[k] >= newMag[dest]) {
        newMag[dest] = mag[k]
        newPhase[dest] = p
      }
    }

    // Persist prev phase and state.
    for (let k = 0; k <= half; k++) prev[k] = phase[k]
    state.first = false

    return { mag: newMag, phase: newPhase }
  }
}

function phaseLockBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let out = stftBatch(data, makeProcess(ratioFn || ratio), { ...opts, ratio, ratioFn })
  return matchGain(out, data)
}

function phaseLockStream(opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let s = stftStream(makeProcess(ratioFn || ratio), { ...opts, ratio, ratioFn })
  return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
}

export default makePitchShift(phaseLockBatch, phaseLockStream)
