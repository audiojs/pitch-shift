import { hann } from 'window-function'

export const PI2 = Math.PI * 2

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

export function wrapPhase(p) {
  return p - Math.round(p / PI2) * PI2
}

let _hannCache = new Map()
export function hannWindow(N) {
  let w = _hannCache.get(N)
  if (w) return w
  w = new Float64Array(N)
  for (let i = 0; i < N; i++) w[i] = hann(i, N)
  _hannCache.set(N, w)
  return w
}

export function isChannelArray(data) {
  return Array.isArray(data) && data.every((c) => c instanceof Float32Array)
}

export function normalizeOptionsInput(data) {
  if (data === undefined || data === null || typeof data === 'object') return data
  throw new TypeError('pitchShift: options must be an object')
}

export function validateInput(data) {
  if (data instanceof Float32Array || isChannelArray(data)) return
  throw new TypeError('pitchShift: input must be Float32Array or array of Float32Array channels')
}

export function resolvePitchParams(opts) {
  let semitones = opts?.semitones ?? 0
  if (!Number.isFinite(semitones)) throw new TypeError('pitchShift: `semitones` must be a finite number')
  let raw = opts?.ratio
  if (typeof raw === 'function' || raw instanceof Float32Array) {
    throw new TypeError('pitchShift: variable `ratio` (function or Float32Array) is only supported by phaseLock and sample')
  }
  let ratio = raw ?? (semitones ? Math.pow(2, semitones / 12) : 1)
  if (!Number.isFinite(ratio) || ratio <= 0) throw new TypeError('pitchShift: `ratio` must be a finite number > 0')
  return { ratio, semitones }
}

// Variable-ratio resolver. Returns `{ ratio, ratioFn }` where `ratio` is the scalar value
// at t=0 (for identity checks and fallbacks) and `ratioFn` is a `(timeSeconds) => ratio`
// function, or `null` when the caller passed a plain scalar. Algorithms that support
// time-varying pitch use `ratioFn`; algorithms that don't should use `resolvePitchParams`
// (which throws on function/array input).
export function resolveRatio(opts) {
  let raw = opts?.ratio
  if (typeof raw === 'function') {
    let r0 = raw(0)
    if (!Number.isFinite(r0) || r0 <= 0) throw new TypeError('pitchShift: `ratio(0)` must be a finite number > 0')
    return { ratio: r0, ratioFn: raw }
  }
  if (raw instanceof Float32Array) {
    if (raw.length === 0) throw new TypeError('pitchShift: `ratio` Float32Array must be non-empty')
    let arr = raw
    let last = arr.length - 1
    // Sampled curve on [0, durationSeconds]; caller supplies `ratioDuration` in seconds.
    // Fallback: treat as a per-sample curve at `sampleRate`.
    let sr = opts?.sampleRate || 44100
    let dur = opts?.ratioDuration ?? (arr.length / sr)
    let fn = (t) => {
      let pos = (t / dur) * last
      if (pos <= 0) return arr[0]
      if (pos >= last) return arr[last]
      let i0 = Math.floor(pos)
      let frac = pos - i0
      return (1 - frac) * arr[i0] + frac * arr[i0 + 1]
    }
    return { ratio: arr[0], ratioFn: fn }
  }
  let { ratio } = resolvePitchParams(opts)
  return { ratio, ratioFn: null }
}

// Rescale `out` in place so its RMS matches `ref`'s RMS. Pitch shift preserves loudness
// by definition, so any STFT bin-shift path that loses or inflates energy through round()
// quantisation / scatter collisions can be corrected with a single global scalar at the
// tail. Bounded correction: only applied when output is in the 0.1..10× ballpark of the
// reference — outside that range the output is either legitimately silent (pitch-up past
// Nyquist, where only aliasing energy remains) or the algorithm is catastrophically broken
// and a blind rescale would hide the problem instead of fixing it.
export function matchGain(out, ref) {
  let no = out.length, nr = ref.length
  let so = 0, sr = 0
  for (let i = 0; i < no; i++) so += out[i] * out[i]
  for (let i = 0; i < nr; i++) sr += ref[i] * ref[i]
  if (so <= 1e-12 || sr <= 1e-12) return out
  let rmsO = Math.sqrt(so / no)
  let rmsR = Math.sqrt(sr / nr)
  let ratio = rmsO / rmsR
  if (ratio < 0.1 || ratio > 10) return out
  let g = rmsR / rmsO
  for (let i = 0; i < no; i++) out[i] *= g
  return out
}

// Hann-windowed sinc read at a fractional source position. `cutoff ∈ (0,1]` sets an
// anti-alias lowpass at `cutoff × Nyquist`; use `cutoff = min(1, 1/stride)` when the
// caller is stepping through the source faster than one sample per read to suppress
// content above the new Nyquist before it folds. `r` is the kernel half-width in
// zero-crossings (8 is standard, giving ≈60 dB stopband on a 2× decimation).
export function sincRead(buf, pos, r, cutoff) {
  let bufLen = buf.length
  let i0 = Math.floor(pos)
  let frac = pos - i0
  let hw = Math.ceil(r / cutoff)
  let s = 0
  for (let k = -hw + 1; k <= hw; k++) {
    let idx = i0 + k
    if (idx < 0 || idx >= bufLen) continue
    let x = k - frac
    let xi = x * cutoff
    let wi = Math.abs(x) / hw
    if (wi >= 1) continue
    let si = Math.abs(xi) < 1e-9 ? 1 : Math.sin(Math.PI * xi) / (Math.PI * xi)
    let w = 0.5 + 0.5 * Math.cos(Math.PI * wi)
    s += buf[idx] * si * cutoff * w
  }
  return s
}

// Hann-windowed sinc resampler with anti-aliasing. When downsampling (inLen > outLen) the
// sinc cutoff scales to outLen/inLen so content above Nyquist/step is suppressed before it
// can fold. At r=8 that is 16 zero-crossings — ≈60 dB stopband on a 2× downsampling test.
// Upsampling (inLen ≤ outLen) uses cutoff=1, identical to the standard reconstruction sinc.
export function resampleTo(data, outLen, r = 8) {
  let inLen = data.length
  let out = new Float32Array(outLen)
  if (outLen === 0 || inLen === 0) return out
  if (outLen === inLen) return new Float32Array(data)
  let step = (inLen - 1) / (outLen - 1)
  let cutoff = step > 1 ? 1 / step : 1
  let hw = Math.ceil(r / cutoff)
  for (let i = 0; i < outLen; i++) {
    let pos = i * step
    let i0 = pos | 0
    let frac = pos - i0
    let s = 0
    for (let k = -hw + 1; k <= hw; k++) {
      let idx = i0 + k
      if (idx < 0 || idx >= inLen) continue
      let x = k - frac
      let xi = x * cutoff
      let wi = Math.abs(x) / hw
      if (wi >= 1) continue
      let si = Math.abs(xi) < 1e-9 ? 1 : Math.sin(Math.PI * xi) / (Math.PI * xi)
      let w = 0.5 + 0.5 * Math.cos(Math.PI * wi)
      s += data[idx] * si * cutoff * w
    }
    out[i] = s
  }
  return out
}

export function mapInput(data, fn, opts) {
  validateInput(data)
  if (data instanceof Float32Array) return fn(data, opts)
  return data.map((c) => fn(c, opts))
}

export function passThroughWriter() {
  return (chunk) => chunk === undefined ? new Float32Array(0) : new Float32Array(chunk)
}

// Streaming adapter for algorithms that need whole-signal look-ahead (e.g. HPSS median
// windows, hybrid's parallel engines). Buffers input; emits empty on writes and the full
// batch result on flush. Canonical simplest form for inherently non-causal algorithms.
export function bufferedStream(batch, opts) {
  let parts = []
  let flushed = false
  return (chunk) => {
    if (chunk === undefined) {
      if (flushed) return new Float32Array(0)
      flushed = true
      let total = 0
      for (let p of parts) total += p.length
      let all = new Float32Array(total)
      let o = 0
      for (let p of parts) { all.set(p, o); o += p.length }
      return batch(all, opts)
    }
    if (flushed) throw new Error('pitchShift: stream already flushed')
    parts.push(new Float32Array(chunk))
    return new Float32Array(0)
  }
}

export function createChannelWriter(factory) {
  let mode = null
  let writers = null

  return (chunk) => {
    if (chunk === undefined) {
      if (!writers) return new Float32Array(0)
      return mode === 'channels' ? writers.map((w) => w()) : writers[0]()
    }

    if (isChannelArray(chunk)) {
      if (!writers) { mode = 'channels'; writers = chunk.map(() => factory()) }
      if (mode !== 'channels' || writers.length !== chunk.length) {
        throw new TypeError('pitchShift: streaming channel count must stay constant')
      }
      return chunk.map((c, i) => writers[i](c))
    }

    if (!(chunk instanceof Float32Array)) {
      throw new TypeError('pitchShift: streaming input must be Float32Array or array of Float32Array channels')
    }

    if (!writers) { mode = 'mono'; writers = [factory()] }
    if (mode !== 'mono') throw new TypeError('pitchShift: cannot mix mono and multi-channel writes')
    return writers[0](chunk)
  }
}

export function makePitchShift(batch, stream) {
  let isVariable = (opts) => {
    let raw = opts?.ratio
    return typeof raw === 'function' || raw instanceof Float32Array
  }
  let isIdentity = (opts) => {
    if (isVariable(opts)) return false
    return resolvePitchParams(opts).ratio === 1
  }
  return function shift(data, opts) {
    if (data instanceof Float32Array) {
      if (isIdentity(opts)) return new Float32Array(data)
      return batch(data, opts)
    }
    if (isChannelArray(data)) {
      if (isIdentity(opts)) return data.map((c) => new Float32Array(c))
      return data.map((c) => batch(c, opts))
    }
    opts = normalizeOptionsInput(data)
    if (isIdentity(opts)) return createChannelWriter(() => passThroughWriter())
    return createChannelWriter(() => stream(opts))
  }
}

