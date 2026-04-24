import { fft, ifft } from 'fourier-transform'
import { stftBatch, stftStream } from '@audio/shift-core/stft'
import { findPeaks, nearestPeak, makeFrameRatio, matchGain, wrapPhase, makePitchShift, resolveRatio } from '@audio/shift-core'

// Formant-preserving pitch shift. The spectral envelope is extracted via cepstral liftering
// (low-quefrency coefficients) from the original frame. A peak-locked phase vocoder then
// shifts pitch (reusing the phase-lock architecture so partials stay coherent). Finally the
// shifted magnitude is divided by its own envelope and multiplied by the original envelope,
// re-imposing vowel timbre on the shifted pitch.

// `preLog`: if true, `mag` is already log-magnitude (skip the log step).
function cepstralEnvelope(mag, N, liftCutoff, preLog = false) {
  let half = N >> 1
  let logMag = new Float64Array(half + 1)
  let zeroIm = new Float64Array(half + 1)
  for (let k = 0; k <= half; k++) logMag[k] = preLog ? mag[k] : Math.log(Math.max(1e-8, mag[k]))

  let cep = ifft(logMag, zeroIm, new Float64Array(N))

  let lifted = new Float64Array(N)
  lifted[0] = cep[0]
  let cutoff = Math.min(liftCutoff, half - 1)
  for (let n = 1; n < cutoff; n++) {
    lifted[n] = cep[n]
    lifted[N - n] = cep[N - n]
  }

  let [envLogRe] = fft(lifted)
  let env = new Float64Array(half + 1)
  for (let k = 0; k <= half; k++) env[k] = Math.exp(envLogRe[k])
  return env
}

function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { N, half, hop, freqPerBin } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  let envelopeWidth = ctx.opts.envelopeWidth ?? Math.max(8, ctx.N >> 6)
  if (!state.prev) {
    state.prev = new Float64Array(half + 1)
    state.syn = new Float64Array(half + 1)
    state.logMagAvg = new Float64Array(half + 1)
    state.first = true
  }
  let { prev, syn, logMagAvg } = state

  // 1. Original spectral envelope extracted from a smoothed log-magnitude.
  // Computing the envelope per-frame directly causes inter-partial bins to fluctuate at
  // the chord beat frequency (e.g. 55 Hz for a 220/275 Hz pair). That 55 Hz beat aliases
  // against the 86 Hz frame rate into ~31 Hz flutter on the correction factor — audible
  // as a soft click on raised chord material. An EMA of log(mag) with α=0.4 (τ ≈ 13 ms
  // at hop=512 / 44.1 kHz) stabilises the envelope: it converges within 3τ ≈ 50 ms
  // (before the 20%-skip activeRegion window opens) and attenuates the 55 Hz oscillation
  // by ≈3×, bringing it below the flicker perception threshold.
  let alpha = 0.6
  for (let k = 0; k <= half; k++) {
    let lm = Math.log(Math.max(1e-8, mag[k]))
    logMagAvg[k] = state.first ? lm : alpha * logMagAvg[k] + (1 - alpha) * lm
  }
  let origEnv = cepstralEnvelope(logMagAvg, N, envelopeWidth, true) // pre-log mode

  // 2. Peak-locked phase vocoder shift — same logic as phase-lock.js. Peaks scatter to
  // shifted dest bins, their region of influence is carried along, and per-peak phase
  // is advanced at the shifted instantaneous frequency.
  let peaks = findPeaks(mag, half)
  let newMag = new Float64Array(half + 1)
  let newPhase = new Float64Array(half + 1)
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
    if (destBin < 0 || destBin > half) { peakDest[i] = -1; continue }
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

  // 3. Re-impose the original vocal-tract envelope. The naive shift carried the envelope
  // along with the pitch — output bin k carries the original envelope at k/ratio. Divide
  // that out, multiply by origEnv[k]. origEnv is extracted from the log-magnitude average
  // so the correction is already temporally stable (see step 1 above).
  for (let k = 0; k <= half; k++) {
    let src = k / ratio
    let i = src | 0
    let f = src - i
    let a = origEnv[Math.min(i, half)]
    let b = origEnv[Math.min(i + 1, half)]
    let shiftedEnvK = a * (1 - f) + b * f
    let corr = origEnv[k] / Math.max(1e-8, shiftedEnvK)
    if (corr > 8) corr = 8
    if (corr < 0.125) corr = 0.125
    newMag[k] *= corr
  }

  return { mag: newMag, phase: newPhase }
}

function formantBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let frameSize = opts?.frameSize ?? 2048
  let out = stftBatch(data, process, { ...opts, ratio, ratioFn, frameSize })
  return matchGain(out, data)
}

function formantStream(opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let frameSize = opts?.frameSize ?? 2048
  let s = stftStream(process, { ...opts, ratio, ratioFn, frameSize })
  return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
}

export default makePitchShift(formantBatch, formantStream)
