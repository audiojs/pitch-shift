import { fft } from 'fourier-transform'
import phaseLock from '@audio/shift-pvoc-lock'
import wsola from '@audio/shift-wsola'
import { hannWindow, makePitchShift, resolvePitchParams, bufferedStream } from '@audio/shift-core'

// Hybrid pitch shifter. Runs two canonical engines in parallel and crossfades between them
// sample-by-sample, driven by a per-sample transient confidence signal:
//
//   out[i] = (1 - τ[i]) · phaseLock(input)[i]  +  τ[i] · wsola(input)[i]
//
// Where τ[i] is derived from spectral-flux transient detection on the input. On sustained
// tonal material τ→0 and the output is purely phase-vocoded. On attacks τ→1 and the output
// is purely WSOLA, whose time-domain similarity search preserves transient shape.
//
// Canonical motivation: no single domain wins everywhere. Frequency-domain methods smear
// transients; time-domain methods mistrack tonal phase. Running both and letting the input
// decide where each is trusted is the simplest principled combination.

function transientConfidence(data, opts) {
  let N = Math.min(1024, data.length)
  if (N < 64) return new Float32Array(data.length)
  let hop = N >> 2
  let half = N >> 1
  let win = hannWindow(N)
  let prev = new Float64Array(half + 1)
  let scratch = new Float64Array(N)
  let flux = []
  for (let pos = 0; pos + N <= data.length; pos += hop) {
    for (let i = 0; i < N; i++) scratch[i] = (data[pos + i] || 0) * win[i]
    let [re, im] = fft(scratch)
    let f = 0
    for (let k = 1; k <= half; k++) {
      let m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      let d = m - prev[k]
      if (d > 0) f += d
      prev[k] = m
    }
    flux.push(Math.log(1 + f))
  }
  if (!flux.length) return new Float32Array(data.length)

  // EMA baseline; z-score above baseline becomes the raw confidence.
  let alpha = 0.1
  let ema = flux[0]
  let raw = new Float32Array(flux.length)
  let threshold = opts?.hybridThreshold ?? 0.8
  for (let i = 0; i < flux.length; i++) {
    ema = alpha * flux[i] + (1 - alpha) * ema
    let z = flux[i] - ema
    raw[i] = Math.min(1, Math.max(0, z / (threshold + 1e-6)))
  }

  // Linear upsample to per-sample.
  let perSample = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) {
    let fpos = i / hop
    let a = Math.floor(fpos)
    if (a >= raw.length - 1) { perSample[i] = raw[raw.length - 1] || 0; continue }
    let frac = fpos - a
    perSample[i] = (1 - frac) * raw[a] + frac * raw[a + 1]
  }

  // Attack/release envelope follower widens transients so the WSOLA grain covers the attack.
  let sr = opts?.sampleRate || 44100
  let attackT = 0.002
  let releaseT = 0.040
  let ca = 1 - Math.exp(-1 / (attackT * sr))
  let cr = 1 - Math.exp(-1 / (releaseT * sr))
  let env = 0
  for (let i = 0; i < perSample.length; i++) {
    let x = perSample[i]
    let c = x > env ? ca : cr
    env += c * (x - env)
    perSample[i] = env
  }
  return perSample
}

function hybridBatch(data, opts) {
  resolvePitchParams(opts) // validate early — wsola rejects variable ratio, catch it here with a clear message
  let pv = phaseLock(data, opts)
  let td = wsola(data, opts)
  let conf = transientConfidence(data, opts)
  let out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) {
    let t = conf[i]
    out[i] = (1 - t) * pv[i] + t * td[i]
  }
  return out
}

// Two engines + crossfade are inherently non-causal — buffer input and batch on flush.
let hybridStream = (opts) => bufferedStream(hybridBatch, opts)

export default makePitchShift(hybridBatch, hybridStream)
