import { fft, ifft } from 'fourier-transform'
import { stftBatch, stftStream } from './stft.js'
import { matchGain, wrapPhase, makePitchShift, resolveRatio } from './util.js'

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

function findPeaks(mag, half) {
  // First-order comparison; ±2 shadows closely-spaced chord partials (see phase-lock.js).
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

function assignedPeak(peaks, k) {
  if (!peaks.length) return -1
  let lo = 0, hi = peaks.length - 1
  while (lo < hi) {
    let mid = (lo + hi) >> 1
    if (peaks[mid] < k) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(peaks[lo - 1] - k) <= Math.abs(peaks[lo] - k)) return lo - 1
  return lo
}

function makeProcess(ratio, envelopeWidth) {
  let ratioFn = typeof ratio === 'function' ? ratio : null
  let scalar = ratioFn ? ratioFn(0) : ratio
  return function process(mag, phase, state, ctx) {
    let { N, half, hop, freqPerBin, sampleRate, frameStart } = ctx
    let ratio = ratioFn ? ratioFn(Math.max(0, frameStart) / sampleRate) : scalar
    if (!Number.isFinite(ratio) || ratio <= 0) ratio = scalar || 1
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
      let newSyn = wrapPhase(syn[k] + shifted * hop)
      peakDest[i] = destBin
      peakSynPhase[i] = newSyn
      syn[k] = newSyn
    }

    for (let k = 0; k <= half; k++) {
      let pi = assignedPeak(peaks, k)
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
}

function formantBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let frameSize = opts?.frameSize ?? 2048
  let envelopeWidth = opts?.envelopeWidth ?? Math.max(8, Math.round(frameSize / 64))
  let out = stftBatch(data, makeProcess(ratioFn || ratio, envelopeWidth), { ...opts, ratio, ratioFn, frameSize })
  return matchGain(out, data)
}

function formantStream(opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let frameSize = opts?.frameSize ?? 2048
  let envelopeWidth = opts?.envelopeWidth ?? Math.max(8, Math.round(frameSize / 64))
  let s = stftStream(makeProcess(ratioFn || ratio, envelopeWidth), { ...opts, ratio, ratioFn, frameSize })
  return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
}

export default makePitchShift(formantBatch, formantStream)
