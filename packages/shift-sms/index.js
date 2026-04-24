import { stftBatch, stftStream } from '@audio/shift-core/stft'
import { makeFrameRatio, matchGain, wrapPhase, makePitchShift, resolveRatio } from '@audio/shift-core'

// Spectral Modeling Synthesis (Serra/Smith) pitch shift.
// Decomposes each frame into sinusoidal peaks (partials) + stochastic residual.
// Partial frequencies are scaled by `ratio`; residual is preserved unchanged.
// Each partial contributes a narrow parabolic lobe at its shifted bin; residual carries the rest.

function parabolicInterpolate(mag, k) {
  let ym1 = mag[k - 1], y0 = mag[k], yp1 = mag[k + 1]
  let denom = ym1 - 2 * y0 + yp1
  if (Math.abs(denom) < 1e-12) return { pos: k, peak: y0 }
  let delta = 0.5 * (ym1 - yp1) / denom
  return { pos: k + delta, peak: y0 - 0.25 * (ym1 - yp1) * delta }
}

function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { half, hop, freqPerBin } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  let maxTracks = ctx.opts.maxTracks ?? Infinity
  let minMag = ctx.opts.minMag ?? 1e-4
  if (!state.prev) {
    state.prev = new Float64Array(half + 1)
    state.syn = new Float64Array(half + 1)
    state.newMag = new Float64Array(half + 1)
    state.newPhase = new Float64Array(half + 1)
    state.residual = new Float64Array(half + 1)
    state.owned = new Uint8Array(half + 1)
    state.first = true
  }
  let { prev, syn, newMag, newPhase, residual, owned } = state

  let maxM = 0
  for (let k = 0; k <= half; k++) if (mag[k] > maxM) maxM = mag[k]
  let floor = Math.max(minMag, maxM * 0.01)

  // Pick peaks (sinusoidal partials). First-neighbour comparison catches closely-spaced
  // chord partials whose mainlobes overlap — a strict ±2 comparison drops the weaker of
  // two adjacent peaks, leaving its energy in the residual and producing audible AM.
  let picked = []
  for (let k = 1; k < half; k++) {
    let v = mag[k]
    if (v < floor) continue
    if (v > mag[k - 1] && v > mag[k + 1]) {
      let { pos, peak } = parabolicInterpolate(mag, k)
      picked.push({ bin: k, fracBin: pos, mag: peak })
    }
  }
  picked.sort((a, b) => b.mag - a.mag)
  if (picked.length > maxTracks) picked.length = maxTracks

  // Residual = original magnitude with the peak lobes zeroed out so the remaining
  // stochastic energy carries no partial content.
  for (let k = 0; k <= half; k++) residual[k] = mag[k]
  let lobeW = 3
  for (let p of picked) {
    let k0 = p.bin
    for (let d = -lobeW; d <= lobeW; d++) {
      let k = k0 + d
      if (k < 0 || k > half) continue
      residual[k] = 0
    }
  }

  newMag.fill(0)
  newPhase.fill(0)
  owned.fill(0)

  for (let p of picked) {
    let k0 = p.bin
    let trueFreq
    if (state.first) trueFreq = p.fracBin * freqPerBin
    else {
      let dp = wrapPhase(phase[k0] - prev[k0] - k0 * freqPerBin * hop)
      trueFreq = k0 * freqPerBin + dp / hop
    }
    let shifted = trueFreq * ratio
    let shiftedBin = shifted / freqPerBin
    let center = Math.round(shiftedBin)
    if (center < 0 || center > half) continue
    // Phase accumulator is keyed on the SOURCE bin — stable across frames — so integer-
    // bin jitter at the destination can't reset a partial's phase mid-note.
    let newSyn = wrapPhase(syn[k0] + shifted * hop)
    syn[k0] = newSyn
    // Single-bin deposit at the nearest dest bin. A symmetric triangular 3-bin spread
    // with common phase is mathematically incorrect: the Hann-windowed FFT of a single
    // sinusoid has alternating-sign coefficients across adjacent bins, not a positive
    // triangle, so a same-phase triangular deposit leaves a residual that beats at the
    // frame rate (hop-rate AM, "soft click" on sustained tones). Placing all the partial
    // magnitude at the center bin with phase advanced at the shifted instantaneous rate
    // lets the overlap-add correctly reconstruct the shifted sinusoid — the main-lobe
    // ±0.5 bin quantisation is acceptable (≤10 Hz at 44.1 kHz / 2048).
    if (!owned[center]) {
      newMag[center] += p.mag
      newPhase[center] = newSyn
      owned[center] = 1
    }
  }

  // Residual (stochastic) bins: shift to their ratio-scaled destination bin with the
  // source analysis phase, but only into bins not already claimed by a partial lobe.
  for (let k = 0; k <= half; k++) {
    let r = residual[k]
    if (r === 0) continue
    let dest = Math.round(k * ratio)
    if (dest < 0 || dest > half || owned[dest]) continue
    newMag[dest] += r
    if (newPhase[dest] === 0) newPhase[dest] = phase[k]
  }

  for (let k = 0; k <= half; k++) prev[k] = phase[k]
  state.first = false
  return { mag: newMag, phase: newPhase }
}

function smsBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let out = stftBatch(data, process, { ...opts, ratio, ratioFn })
  return matchGain(out, data)
}

function smsStream(opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let s = stftStream(process, { ...opts, ratio, ratioFn })
  return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
}

export default makePitchShift(smsBatch, smsStream)
