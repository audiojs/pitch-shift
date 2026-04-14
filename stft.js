import { fft, ifft } from 'fourier-transform'
import { PI2, hannWindow } from './util.js'

// STFT primitive for pitch shifting: analysis hop = synthesis hop, output length = input length.
// `process(mag, phase, state, ctx)` returns the modified spectrum for each frame as `{ mag, phase }`.
// Frame layout: frame k covers samples [k*hop, k*hop+N) of the padded input.

function scratch(N, half) {
  return {
    f: new Float64Array(N),
    mag: new Float64Array(half + 1),
    phase: new Float64Array(half + 1),
    re: new Float64Array(half + 1),
    im: new Float64Array(half + 1),
  }
}

function analyse(buf, pos, win, sc, half) {
  let N = win.length
  let f = sc.f
  for (let i = 0; i < N; i++) f[i] = (buf[pos + i] || 0) * win[i]
  let [re, im] = fft(f)
  for (let k = 0; k <= half; k++) {
    sc.mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    sc.phase[k] = Math.atan2(im[k], re[k])
  }
}

function synth(r, sc, half) {
  let re = sc.re, im = sc.im
  for (let k = 0; k <= half; k++) {
    re[k] = r.mag[k] * Math.cos(r.phase[k])
    im[k] = r.mag[k] * Math.sin(r.phase[k])
  }
  return ifft(re, im)
}

function winSqFloor(win, hop) {
  let N = win.length, min = Infinity
  for (let i = 0; i < hop; i++) {
    let s = 0
    for (let j = i; j < N; j += hop) s += win[j] * win[j]
    if (s > 0 && s < min) min = s
  }
  return min === Infinity ? 1 : min
}

function makeCtx(opts, N, half, hop) {
  let raw = opts?.ratio
  let variable = typeof raw === 'function' || raw instanceof Float32Array
  return {
    N, half, hop,
    freqPerBin: PI2 / N,
    ratio: variable ? undefined : (raw ?? 1),
    ratioFn: opts?.ratioFn || null,
    frameStart: 0,
    sampleRate: opts?.sampleRate || 44100,
    opts: opts || {},
  }
}

export function stftBatch(data, process, opts) {
  let N = opts?.frameSize || 2048
  let hop = opts?.hopSize || (N >> 2)
  let half = N >> 1
  let win = hannWindow(N)
  let ctx = makeCtx(opts, N, half, hop)

  let inLen = data.length
  // Zero-pad by N at the front and back so edge samples are fully windowed.
  let pad = N
  let paddedLen = inLen + pad * 2
  let padded = new Float32Array(paddedLen)
  padded.set(data, pad)

  let out = new Float32Array(paddedLen)
  let norm = new Float32Array(paddedLen)
  let state = {}
  let sc = scratch(N, half)

  for (let pos = 0; pos + N <= paddedLen; pos += hop) {
    ctx.frameStart = pos - pad
    analyse(padded, pos, win, sc, half)
    let r = process(sc.mag, sc.phase, state, ctx)
    let sf = synth(r, sc, half)
    for (let i = 0; i < N; i++) {
      out[pos + i] += sf[i] * win[i]
      norm[pos + i] += win[i] * win[i]
    }
  }

  let floor = winSqFloor(win, hop)
  let result = new Float32Array(inLen)
  for (let i = 0; i < inLen; i++) {
    let j = i + pad
    let n = norm[j] < floor ? floor : norm[j]
    result[i] = n > 1e-10 ? out[j] / n : 0
  }
  return result
}

// Streaming STFT: input samples arrive in chunks, output is emitted as soon as frames covering
// them are processed. Absolute stream coordinates are used throughout.
//
//   inStart = absolute position of inBuf[0]
//   totalIn = total input samples written so far (not counting flush pad)
//   nextFrame = next frame's absolute start position (in stream coordinates, can be negative)
//   outStart = absolute position of outBuf[0]
//   emitted = absolute position up to which we've returned output
//
// A front pad of N zeros is prepended so the first few frames have valid content.
// On flush, a tail pad of N zeros is appended so the last frames are fully analysed.
export function stftStream(process, opts) {
  let N = opts?.frameSize || 2048
  let hop = opts?.hopSize || (N >> 2)
  let half = N >> 1
  let win = hannWindow(N)
  let ctx = makeCtx(opts, N, half, hop)
  let pad = N

  let inBuf = new Float32Array(N * 8)
  let inStart = -pad        // inBuf[0] is stream position -pad (the front pad)
  let inLen = pad           // the first `pad` samples are zero (front pad)
  let outBuf = new Float32Array(N * 8)
  let normBuf = new Float32Array(N * 8)
  let outStart = -pad
  let totalIn = 0
  let nextFrame = -pad      // first frame starts at stream position -pad
  let emitted = 0
  let flushed = false
  let state = {}
  let sc = scratch(N, half)
  let floor = winSqFloor(win, hop)

  function ensureIn(need) {
    if (need <= inBuf.length) return
    let nb = new Float32Array(Math.max(need, inBuf.length * 2))
    nb.set(inBuf.subarray(0, inLen))
    inBuf = nb
  }

  function ensureOut(needLen) {
    if (needLen <= outBuf.length) return
    let len = Math.max(needLen, outBuf.length * 2)
    let ob = new Float32Array(len)
    let nb = new Float32Array(len)
    ob.set(outBuf)
    nb.set(normBuf)
    outBuf = ob
    normBuf = nb
  }

  function appendIn(chunk) {
    ensureIn(inLen + chunk.length)
    inBuf.set(chunk, inLen)
    inLen += chunk.length
  }

  function processReadyFrames(limitAbs) {
    while (nextFrame + N <= limitAbs) {
      ctx.frameStart = nextFrame
      let inPos = nextFrame - inStart
      analyse(inBuf, inPos, win, sc, half)
      let r = process(sc.mag, sc.phase, state, ctx)
      let sf = synth(r, sc, half)
      let outPos = nextFrame - outStart
      ensureOut(outPos + N)
      for (let i = 0; i < N; i++) {
        outBuf[outPos + i] += sf[i] * win[i]
        normBuf[outPos + i] += win[i] * win[i]
      }
      nextFrame += hop
    }
  }

  function trimIn() {
    let keepFrom = nextFrame - inStart
    if (keepFrom > N * 2) {
      let drop = keepFrom - N
      inBuf.copyWithin(0, drop, inLen)
      inLen -= drop
      inStart += drop
    }
  }

  function trimOut(emittedAbs) {
    let dropFront = emittedAbs - outStart
    if (dropFront > N * 4) {
      let keep = outBuf.length - dropFront
      outBuf.copyWithin(0, dropFront)
      outBuf.fill(0, keep)
      normBuf.copyWithin(0, dropFront)
      normBuf.fill(0, keep)
      outStart += dropFront
    }
  }

  function emit(uptoAbs) {
    uptoAbs = Math.min(uptoAbs, totalIn)
    if (uptoAbs <= emitted) return new Float32Array(0)
    let count = uptoAbs - emitted
    let out = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      let j = emitted + i - outStart
      let n = normBuf[j] < floor ? floor : normBuf[j]
      out[i] = n > 1e-10 ? outBuf[j] / n : 0
    }
    emitted = uptoAbs
    trimOut(emitted)
    return out
  }

  return {
    write(chunk) {
      if (flushed) throw new Error('stft stream already flushed')
      appendIn(chunk)
      totalIn += chunk.length
      // Frames whose synthesis window [frame, frame+N) lies entirely within the input we have.
      // After processing frame k, output samples up to k+hop are stable (next frame starts at k+hop).
      let inputEnd = inStart + inLen
      processReadyFrames(inputEnd)
      trimIn()
      // Safe output boundary: the sample at position p is stable once all frames starting
      // at positions ≤ p have been processed, i.e. nextFrame > p.
      let safe = nextFrame
      return emit(safe)
    },
    flush() {
      if (flushed) return new Float32Array(0)
      flushed = true
      // Append a tail pad so the last input samples get full coverage.
      appendIn(new Float32Array(pad))
      processReadyFrames(inStart + inLen)
      return emit(totalIn)
    }
  }
}

export function makeStftShift(process) {
  return {
    batch(data, opts) {
      return stftBatch(data, process, opts)
    },
    stream(opts) {
      let s = stftStream(process, opts)
      return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
    }
  }
}
