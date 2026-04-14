// Quality metrics for pitch-shift algorithms. Each measures a specific canonical property:
// pitch accuracy, harmonic cleanliness, aliasing, timbre drift, transient localization,
// formant preservation. All metrics take Float32Array signals and return scalars.

import { fft, ifft } from 'fourier-transform'

const PI2 = Math.PI * 2

export function rms(data) {
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / Math.max(1, data.length))
}

export function correlation(a, b) {
  let n = Math.min(a.length, b.length)
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return dot / Math.sqrt(Math.max(1e-12, aa * bb))
}

// Active-signal extent. Sampler-style shifters (ratio>1) zero-pad the tail of the output
// so the buffer length matches the input, but the middle-window analysis windows would then
// straddle signal + silence. Trim the trailing (and leading) zero region so downstream
// middle-60% metrics analyse only the valid audio.
export function activeRegion(data, thresh = 1e-4) {
  let n = data.length
  let peak = 0
  for (let i = 0; i < n; i++) { let v = Math.abs(data[i]); if (v > peak) peak = v }
  if (peak < 1e-12) return { start: 0, end: n }
  let floor = Math.max(thresh, peak * 1e-3)
  let start = 0
  while (start < n && Math.abs(data[start]) < floor) start++
  let end = n
  while (end > start && Math.abs(data[end - 1]) < floor) end--
  if (end - start < 16) return { start: 0, end: n }
  return { start, end }
}

// Zero-crossing frequency estimator. Crude but bias-free for clean tones — used as a
// sanity check alongside autocorrelation. Operates on the middle 60% of the active signal
// (trimming sampler tail silence) to skip edge artifacts.
export function zeroCrossingFreq(data, sampleRate) {
  let { start: a, end: b } = activeRegion(data)
  let len = b - a
  let start = a + Math.floor(len * 0.2)
  let end = a + Math.floor(len * 0.8)
  let crossings = 0
  let prev = data[start]
  for (let i = start + 1; i < end; i++) {
    let curr = data[i]
    if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) crossings++
    prev = curr
  }
  return crossings / (2 * (end - start) / sampleRate)
}

// Autocorrelation pitch estimator with parabolic interpolation. Accurate to a small fraction
// of a sample for clean tones. Window over the middle 60% of `data`.
export function estimateF0(data, sampleRate, minFreq = 50, maxFreq = 2000) {
  let start = Math.floor(data.length * 0.2)
  let end = Math.floor(data.length * 0.8)
  let n = end - start
  let maxTau = Math.min(n - 1, Math.floor(sampleRate / minFreq))
  let minTau = Math.max(1, Math.floor(sampleRate / maxFreq))

  let bestTau = minTau
  let bestCorr = -Infinity
  for (let tau = minTau; tau <= maxTau; tau++) {
    let c = 0
    for (let i = 0; i + tau < n; i++) c += data[start + i] * data[start + i + tau]
    if (c > bestCorr) { bestCorr = c; bestTau = tau }
  }

  let corrAt = (tau) => {
    let c = 0
    for (let i = 0; i + tau < n; i++) c += data[start + i] * data[start + i + tau]
    return c
  }
  let cm = corrAt(bestTau - 1)
  let c0 = bestCorr
  let cp = corrAt(bestTau + 1)
  let denom = cm - 2 * c0 + cp
  let offset = denom !== 0 ? 0.5 * (cm - cp) / denom : 0
  let tau = bestTau + offset
  return tau > 0 ? sampleRate / tau : 0
}

// Goertzel single-bin DFT magnitude. Used to measure energy at a specific frequency for
// THD and centroid calculations — more accurate than FFT binning for non-bin frequencies.
function goertzelMag(data, freq, sampleRate) {
  if (freq <= 0 || freq >= sampleRate / 2) return 0
  let w = PI2 * freq / sampleRate
  let c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  let { start: a, end: b } = activeRegion(data)
  let len = b - a
  let start = a + Math.floor(len * 0.2)
  let end = a + Math.floor(len * 0.8)
  for (let i = start; i < end; i++) {
    let s = data[i] + c * s1 - s2
    s2 = s1
    s1 = s
  }
  let re = s1 - s2 * Math.cos(w)
  let im = s2 * Math.sin(w)
  return Math.sqrt(re * re + im * im) / Math.max(1, end - start)
}

// Total harmonic distortion, percent. Given a fundamental `f0`, measure magnitude at
// f0, 2f0, 3f0, ... up to Nyquist and report sqrt(sum(h[2:]^2)) / h[1]. A perfect sine
// shifter reports ~0; aliased or scatter-broken shifters show dozens of percent.
export function thd(data, f0, sampleRate, nHarmonics = 8) {
  if (f0 <= 0) return NaN
  let h1 = goertzelMag(data, f0, sampleRate)
  if (h1 <= 1e-9) return NaN
  let sum = 0
  for (let k = 2; k <= nHarmonics; k++) {
    let fk = f0 * k
    if (fk >= sampleRate / 2) break
    let hk = goertzelMag(data, fk, sampleRate)
    sum += hk * hk
  }
  return 100 * Math.sqrt(sum) / h1
}

// Aliasing ratio: for a high-frequency input shifted above Nyquist, canonical behaviour is
// silence (nothing valid to reproduce). Leftover RMS normalized to input RMS indicates the
// amount of folded-back aliased energy.
export function aliasRatio(out, refIn) {
  let { start, end } = activeRegion(out)
  let outActive = out.subarray(start, end)
  return rms(outActive) / Math.max(1e-12, rms(refIn))
}

function nextPow2(n) {
  let p = 1
  while (p < n) p <<= 1
  return p
}

// Spectral centroid (Hz) via Hann-windowed FFT over the middle of the signal. For an
// unshifted signal vs its shifted version, centroid(out) / centroid(in) should track
// `ratio` for a faithful shifter.
export function spectralCentroid(data, sampleRate) {
  let { start: a, end: b } = activeRegion(data)
  let len = b - a
  let N = Math.min(nextPow2(Math.max(256, Math.floor(len * 0.5))), 8192)
  let pos = a + Math.max(0, Math.floor((len - N) / 2))
  let f = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    let x = data[pos + i] || 0
    let w = 0.5 - 0.5 * Math.cos(PI2 * i / (N - 1))
    f[i] = x * w
  }
  let [re, im] = fft(f)
  let half = N >> 1
  let num = 0, den = 0
  for (let k = 1; k <= half; k++) {
    let m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    let freq = k * sampleRate / N
    num += freq * m
    den += m
  }
  return den > 1e-12 ? num / den : 0
}

export function centroidRatioError(outBuf, inBuf, sampleRate, targetRatio) {
  let cin = spectralCentroid(inBuf, sampleRate)
  let cout = spectralCentroid(outBuf, sampleRate)
  if (cin <= 0) return NaN
  return Math.abs(cout / cin - targetRatio) / targetRatio
}

// Onset-period drift for a Dirac impulse train. The input has impulses every `inputPeriod`
// samples. After pitch-shift, output impulses land at `inputPeriod/ratio` in the source-stride
// sense. We measure actual output period via autocorrelation and report the relative error.
export function onsetPeriodError(out, expectedPeriod, sampleRate) {
  let { start, end } = activeRegion(out)
  let n = end - start
  let env = new Float32Array(n)
  for (let i = 0; i < n; i++) env[i] = Math.abs(out[start + i])
  let maxTau = Math.min(n >> 1, Math.round(expectedPeriod * 2))
  let minTau = Math.max(2, Math.round(expectedPeriod * 0.5))
  let best = minTau
  let bestC = -Infinity
  for (let tau = minTau; tau <= maxTau; tau++) {
    let c = 0
    for (let i = 0; i + tau < n; i++) c += env[i] * env[i + tau]
    if (c > bestC) { bestC = c; best = tau }
  }
  return Math.abs(best - expectedPeriod) / expectedPeriod
}

// Attack envelope correlation. For a plucked/struck signal, compute the smoothed absolute-
// value envelope of both input and output and measure similarity. A perfect transient-
// preserving shifter scores near 1; time-smeared shifters drop.
export function attackEnvelopeCorr(inBuf, outBuf, sampleRate, smoothMs = 5) {
  let env = (buf) => {
    let win = Math.max(1, Math.floor(sampleRate * smoothMs / 1000))
    let e = new Float32Array(buf.length)
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      sum += Math.abs(buf[i])
      if (i >= win) sum -= Math.abs(buf[i - win])
      e[i] = sum / Math.min(i + 1, win)
    }
    return e
  }
  let a = env(inBuf)
  let b = env(outBuf)
  let n = Math.min(a.length, b.length)
  return correlation(a.subarray(0, n), b.subarray(0, n))
}

// Formant preservation distance. Both signals are passed through a cepstral envelope extractor
// (real cepstrum, low-quefrency lifter) and compared in the log-magnitude domain. Small values
// mean the spectral envelope (and thus formant positions) survive the pitch shift.
export function formantDistance(inBuf, outBuf, sampleRate, frameSize = 2048) {
  let N = frameSize
  let half = N >> 1
  let envOf = (buf) => {
    let { start: a, end: b } = activeRegion(buf)
    let len = b - a
    let pos = a + Math.max(0, Math.floor((len - N) / 2))
    let f = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      let x = buf[pos + i] || 0
      let w = 0.5 - 0.5 * Math.cos(PI2 * i / (N - 1))
      f[i] = x * w
    }
    let [re, im] = fft(f)
    let logMag = new Float64Array(half + 1)
    for (let k = 0; k <= half; k++) {
      let m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      logMag[k] = Math.log(Math.max(1e-8, m))
    }
    let cep = ifft(logMag, new Float64Array(half + 1))
    let lift = Math.max(8, Math.round(N / 64))
    let lifted = new Float64Array(N)
    lifted[0] = cep[0]
    for (let n = 1; n < lift && n < half; n++) {
      lifted[n] = cep[n]
      lifted[N - n] = cep[N - n]
    }
    let [envRe] = fft(lifted)
    let env = new Float64Array(half + 1)
    for (let k = 0; k <= half; k++) env[k] = envRe[k]
    return env
  }
  let ea = envOf(inBuf)
  let eb = envOf(outBuf)
  let s = 0
  for (let k = 0; k < ea.length; k++) {
    let d = ea[k] - eb[k]
    s += d * d
  }
  return Math.sqrt(s / ea.length)
}

// AM-envelope coherence. Input is an amplitude-modulated sine at `modRate`; we measure how
// much of that modulation survives the pitch shift. Rectified-signal Goertzel at `modRate`
// isolates the slow envelope component (carrier harmonics sit at 2·fc, 4·fc, far above);
// `depth = |Goertzel(|x|, modRate)| / mean|x|` is the normalized modulation depth. Returning
// the symmetric similarity `min(depthOut, depthIn) / max(depthOut, depthIn)` gives a value
// in [0, 1] where 1 means the output envelope carries exactly the same AM strength as the
// input. Phase-vocoder families score near 1 by construction; grain-rate and random-phase
// methods cannot preserve the envelope and score low. This metric tests phase coherence
// across frames — a distinct signal from per-frame stream-vs-batch correlation.
function envelopeDepthAt(buf, modRate, sampleRate) {
  let { start: a, end: b } = activeRegion(buf)
  let active = b - a
  let start = a + Math.floor(active * 0.2)
  let end = a + Math.floor(active * 0.8)
  let len = end - start
  if (len <= 0) return 0
  let mean = 0
  for (let i = start; i < end; i++) mean += Math.abs(buf[i])
  mean /= len
  if (mean < 1e-9) return 0
  let w = PI2 * modRate / sampleRate
  let c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = start; i < end; i++) {
    let x = Math.abs(buf[i]) - mean
    let s = x + c * s1 - s2
    s2 = s1
    s1 = s
  }
  let re = s1 - s2 * Math.cos(w)
  let im = s2 * Math.sin(w)
  let mag = Math.sqrt(re * re + im * im) / len
  return mag / mean
}

export function phaseCoherence(inBuf, outBuf, modRate, sampleRate) {
  let dIn = envelopeDepthAt(inBuf, modRate, sampleRate)
  let dOut = envelopeDepthAt(outBuf, modRate, sampleRate)
  if (dIn < 1e-6 || dOut < 1e-6) return 0
  return Math.min(dIn, dOut) / Math.max(dIn, dOut)
}

// Log-magnitude spectral distance between two signals. Takes the active region of each,
// Hann-windows a centred frame of size N, FFTs, and compares zero-mean log-magnitude
// spectra via RMSE. Gain-invariant (mean-subtracted) and phase-invariant (magnitude only),
// so it directly measures how close the timbre/harmonic content of `out` is to `ref`.
// Used against a canonical ground-truth shifted reference (e.g. sine(f·ratio)) to score
// overall shift fidelity independent of per-metric heuristics.
export function spectralDistance(out, ref, sampleRate, N = 4096) {
  let framed = (buf) => {
    let { start: a, end: b } = activeRegion(buf)
    let len = b - a
    let M = N
    while (M > 256 && M > len) M >>= 1
    let pos = a + Math.max(0, Math.floor((len - M) / 2))
    let f = new Float64Array(M)
    for (let i = 0; i < M; i++) {
      let x = buf[pos + i] || 0
      let w = 0.5 - 0.5 * Math.cos(PI2 * i / (M - 1))
      f[i] = x * w
    }
    let [re, im] = fft(f)
    let half = M >> 1
    let mag = new Float64Array(half + 1)
    for (let k = 0; k <= half; k++) mag[k] = Math.log(Math.max(1e-8, Math.sqrt(re[k] * re[k] + im[k] * im[k])))
    return mag
  }
  let a = framed(out)
  let b = framed(ref)
  let len = Math.min(a.length, b.length)
  let ma = 0, mb = 0
  for (let k = 0; k < len; k++) { ma += a[k]; mb += b[k] }
  ma /= len
  mb /= len
  let s = 0
  for (let k = 0; k < len; k++) {
    let d = (a[k] - ma) - (b[k] - mb)
    s += d * d
  }
  return Math.sqrt(s / len)
}

// Loudness preservation ratio: RMS(out) / RMS(ref), measured over each signal's active
// region. A faithful pitch shifter preserves loudness by definition, so this sits at ~1.0.
// Distance from 1.0 is the symptom; the log-ratio `log2(lo)` is what the ear actually tracks
// but for a sanity gate a simple ratio is enough.
export function loudnessRatio(out, ref) {
  let { start: oa, end: ob } = activeRegion(out)
  let { start: ra, end: rb } = activeRegion(ref)
  let ro = rms(out.subarray(oa, ob))
  let rr = rms(ref.subarray(ra, rb))
  if (rr < 1e-9) return NaN
  return ro / rr
}

// Duration preservation ratio: length(out) / length(ref). Pitch shift is a length-invariant
// operation, so this should be exactly 1. `sample` zero-pads or truncates to match buffer size;
// stretch-based families trim. Anything else is a bug.
export function durationRatio(out, ref) {
  return out.length / Math.max(1, ref.length)
}

// Chord-aware pitch error. For a sum of sines at `freqs`, the correct output concentrates
// energy at `freqs*ratio`. We measure the energy actually delivered at the expected harmonics
// vs the leakage everywhere else, and report `1 - on/total` so 0 means every expected
// component landed cleanly and 1 means nothing did. More robust than estimateF0 on chords
// (which picks the GCD subharmonic).
export function harmonicShiftError(out, freqs, ratio, sampleRate) {
  // Goertzel with this formulation returns A/2 for a unit cosine, so a pure single-tone
  // fixture contributes 2·m² = (A/2)² · 2 which equals the half-cycle mean square A²/2 —
  // the same value the full RMS² integrates. Summing 2·m² across harmonics therefore has
  // the same units as the output's mean square, and the ratio is gain-invariant.
  let on = 0
  for (let f of freqs) {
    let m = goertzelMag(out, f * ratio, sampleRate)
    on += 2 * m * m
  }
  let { start, end } = activeRegion(out)
  let total = 0
  for (let i = start; i < end; i++) total += out[i] * out[i]
  total /= Math.max(1, end - start)
  if (total < 1e-12) return 1
  return Math.max(0, 1 - on / total)
}

// Peak-frequency accuracy on a chord. For each expected shifted fundamental, scan a ±20 Hz
// window around it via narrow Goertzel sweeps (0.5 Hz step) to locate the nearest true
// spectral peak in the output. Returns the maximum absolute deviation in Hz across all
// expected partials. Catches peak-detection bugs where a partial is shadowed by an adjacent
// one and its energy emerges at the wrong shifted frequency (e.g. bin-rounded to the wrong
// region of influence in peak-locked vocoders).
export function chordPeakFreqError(out, baseFreqs, ratio, sampleRate) {
  let { start, end } = activeRegion(out)
  let lo = start + Math.floor((end - start) * 0.2)
  let hi = start + Math.floor((end - start) * 0.8)
  let N = hi - lo
  if (N <= 0) return Infinity
  let maxErr = 0
  for (let f of baseFreqs) {
    let target = f * ratio
    let bestF = target
    let bestMag = 0
    for (let probe = target - 20; probe <= target + 20; probe += 0.5) {
      let w = PI2 * probe / sampleRate
      let c = 2 * Math.cos(w)
      let s1 = 0, s2 = 0
      for (let i = lo; i < hi; i++) {
        let s = out[i] + c * s1 - s2
        s2 = s1
        s1 = s
      }
      let re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w)
      let mag = Math.sqrt(re * re + im * im) / N
      if (mag > bestMag) { bestMag = mag; bestF = probe }
    }
    let err = Math.abs(bestF - target)
    if (err > maxErr) maxErr = err
  }
  return maxErr
}

// Hop-rate amplitude modulation depth. Measures |Goertzel(|out|, rate)| / mean|out| over
// the sustained portion, where `rate = sampleRate / synHop`. A perfect phase vocoder has
// zero AM at this rate; scatter-sum schemes (Bernsee) get visible AM because colliding
// source bins sum non-coherently at the dest bin, producing an envelope ripple that times
// exactly with frame boundaries — what users hear as a "soft click" on sustained material.
export function hopRateMod(out, sampleRate, synHop) {
  let { start, end } = activeRegion(out)
  let lo = start + Math.floor((end - start) * 0.2)
  let hi = start + Math.floor((end - start) * 0.8)
  let N = hi - lo
  if (N <= 0) return 0
  let mean = 0
  for (let i = lo; i < hi; i++) mean += Math.abs(out[i])
  mean /= N
  if (mean < 1e-9) return 0
  let rate = sampleRate / synHop
  let w = PI2 * rate / sampleRate
  let c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = lo; i < hi; i++) {
    let x = Math.abs(out[i]) - mean
    let s = x + c * s1 - s2
    s2 = s1
    s1 = s
  }
  let re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w)
  return Math.sqrt(re * re + im * im) / N / mean
}

// Stream-vs-batch consistency: run the algorithm batch, then via a streaming writer fed
// variable-sized chunks, and correlate the two outputs. 1.0 means identical.
export function streamConsistency(fn, input, opts, boundaries = [257, 1031, 4097]) {
  let batch = fn(input, opts)
  let writer = fn(opts)
  let parts = []
  let start = 0
  for (let b of boundaries) {
    parts.push(writer(input.subarray(start, b)))
    start = b
  }
  if (start < input.length) parts.push(writer(input.subarray(start)))
  parts.push(writer())
  let len = 0
  for (let p of parts) len += p.length
  let stream = new Float32Array(len)
  let o = 0
  for (let p of parts) { stream.set(p, o); o += p.length }
  return correlation(batch, stream.subarray(0, batch.length))
}
