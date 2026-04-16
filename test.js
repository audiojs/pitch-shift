import pitchShift, { ola, vocoder, phaseLock, transient, psola, wsola, formant, granular, paulstretch, sms, hpss, sample, hybrid } from './index.js'
import test, { ok, is, throws, run } from 'tst'

const sampleRate = 44100

function sine(freq, duration) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * i / sampleRate)
  return out
}

function concat(chunks) {
  let len = chunks.reduce((s, c) => s + c.length, 0)
  let out = new Float32Array(len), offset = 0
  for (let c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

function concatChannels(chunks) {
  let ch = chunks[0].length
  return Array.from({ length: ch }, (_, i) => concat(chunks.map(c => c[i])))
}

function rms(data) {
  let s = 0
  for (let v of data) s += v * v
  return Math.sqrt(s / Math.max(1, data.length))
}

function zeroCrossFreq(data) {
  let a = 0, b = data.length
  for (let i = data.length - 1; i >= 0; i--) if (Math.abs(data[i]) > 1e-6) { b = i + 1; break }
  for (let i = 0; i < b; i++) if (Math.abs(data[i]) > 1e-6) { a = i; break }
  let len = b - a
  let start = a + Math.floor(len * 0.2), end = a + Math.floor(len * 0.8)
  let crossings = 0, prev = data[start]
  for (let i = start + 1; i < end; i++) {
    let curr = data[i]
    if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) crossings++
    prev = curr
  }
  return crossings / (2 * (end - start) / sampleRate)
}

function runChunked(writer, data, boundaries) {
  let parts = [], start = 0
  for (let b of boundaries) { parts.push(writer(data.subarray(start, b))); start = b }
  if (start < data.length) parts.push(writer(data.subarray(start)))
  parts.push(writer())
  return parts
}

const sine440 = sine(440, 0.5)
const sine660 = sine(660, 0.5)

// ─── Each algorithm: batch output is a Float32Array of the same length ────────

for (let [name, fn] of [
  ['ola', ola], ['vocoder', vocoder], ['phaseLock', phaseLock], ['transient', transient],
  ['psola', psola], ['wsola', wsola], ['formant', formant], ['granular', granular],
  ['paulstretch', paulstretch], ['sms', sms], ['hpss', hpss],
  ['sample', sample], ['hybrid', hybrid], ['pitchShift', pitchShift],
]) {
  test(name, () => {
    let out = fn(sine440, { ratio: 1.5, sampleRate })
    ok(out instanceof Float32Array, 'returns Float32Array')
    is(out.length, sine440.length, 'preserves length')
    ok(rms(out) > 0, 'output is non-silent')
  })
}

// ─── Streaming API ────────────────────────────────────────────────────────────

test('streaming produces Float32Arrays and preserves total length', () => {
  let write = phaseLock({ ratio: 1.5 })
  let chunk1 = sine440.subarray(0, 11025)
  let chunk2 = sine440.subarray(11025)
  let out1 = write(chunk1), out2 = write(chunk2), tail = write()
  ok(out1 instanceof Float32Array, 'chunk output is Float32Array')
  ok(out2 instanceof Float32Array, 'chunk output is Float32Array')
  ok(tail instanceof Float32Array, 'flush output is Float32Array')
  is(concat([out1, out2, tail]).length, sine440.length, 'total length preserved')
})

test('default pitchShift streaming', () => {
  let write = pitchShift({ ratio: 1.5 })
  is(typeof write, 'function', 'writer is a function')
  let chunk1 = sine440.subarray(0, 11025), chunk2 = sine440.subarray(11025)
  is(concat([write(chunk1), write(chunk2), write()]).length, sine440.length, 'total length preserved')
})

test('chunk boundary stability', () => {
  let batch = phaseLock(sine440, { ratio: 1.5 })
  for (let boundaries of [[257, 1031, 4097], [512, 2048, 8192], [11025]]) {
    let stream = concat(runChunked(phaseLock({ ratio: 1.5 }), sine440, boundaries))
    is(stream.length, sine440.length, 'length preserved for boundary set ' + boundaries)
    let dot = 0, aa = 0, bb = 0
    for (let i = 0; i < batch.length; i++) { dot += batch[i]*stream[i]; aa += batch[i]*batch[i]; bb += stream[i]*stream[i] }
    let corr = dot / Math.sqrt(Math.max(1e-12, aa*bb))
    ok(corr > 0.85, `streaming matches batch (corr=${corr.toFixed(3)}) for boundaries ${boundaries}`)
  }
})

// ─── Pitch accuracy ───────────────────────────────────────────────────────────

test('pitch accuracy', () => {
  for (let [name, fn, tol] of [
    ['phaseLock', phaseLock, 12], ['vocoder', vocoder, 12], ['transient', transient, 12],
    ['sms', sms, 12], ['hpss', hpss, 12], ['hybrid', hybrid, 15],
    ['paulstretch', paulstretch, 12], ['psola', psola, 3], ['wsola', wsola, 5],
    ['sample', sample, 5], ['granular', granular, 5], ['ola', ola, 5],
  ]) {
    let out = fn(sine440, { ratio: 1.5, sampleRate })
    let f = zeroCrossFreq(out)
    ok(Math.abs(f - 660) < tol, `${name}: 440 Hz → ${f.toFixed(1)} Hz (expected 660 ± ${tol})`)
  }
})

// ─── Variable ratio ───────────────────────────────────────────────────────────

test('variable ratio: phaseLock and sample accept time-function', () => {
  let curve = t => 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t)
  for (let [name, fn] of [['phaseLock', phaseLock], ['sample', sample]]) {
    let out = fn(sine440, { ratio: curve, sampleRate })
    ok(out instanceof Float32Array, `${name} returns Float32Array`)
    is(out.length, sine440.length, `${name} preserves length`)
    ok(rms(out) > 0.1, `${name} output is non-silent`)
  }
})

test('variable ratio: spectral algorithms reject function ratio', () => {
  let curve = t => 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t)
  for (let [name, fn] of [['vocoder', vocoder], ['transient', transient], ['psola', psola]]) {
    throws(() => fn(sine440, { ratio: curve, sampleRate }), /variable|supported/, `${name} rejects function ratio`)
  }
})

// ─── Auto-selection ───────────────────────────────────────────────────────────

test('pitchShift selects sms for content=tonal', () => {
  let decision = null
  let out = pitchShift(sine440, { ratio: 1.5, content: 'tonal', onDecision: d => { decision = d } })
  ok(out instanceof Float32Array, 'returns Float32Array')
  is(decision?.method, 'sms', 'tonal content selects sms')
})

// ─── Multi-channel ────────────────────────────────────────────────────────────

test('multi-channel batch', () => {
  let stereo = [sine440, sine660]
  let out = phaseLock(stereo, { ratio: 1.5 })
  ok(Array.isArray(out), 'returns array')
  is(out.length, 2, 'channel count preserved')
  ok(out.every((ch, i) => ch instanceof Float32Array && ch.length === stereo[i].length), 'channels are correct length')
})

test('multi-channel streaming', () => {
  let write = phaseLock({ ratio: 1.5 })
  let parts = [
    write([sine440.subarray(0, 11025), sine660.subarray(0, 11025)]),
    write([sine440.subarray(11025),    sine660.subarray(11025)]),
    write(),
  ]
  ok(parts.every(Array.isArray), 'each flush is an array of channels')
  let stereoOut = concatChannels(parts)
  is(stereoOut.length, 2, 'channel count preserved')
  is(stereoOut[0].length, sine440.length, 'left channel length preserved')
  is(stereoOut[1].length, sine660.length, 'right channel length preserved')
})

// ─── Identity and edge cases ──────────────────────────────────────────────────

test('identity ratio=1 passes audio through unchanged', () => {
  let write = phaseLock({ ratio: 1 })
  let out = concat([write(sine440.subarray(0, 11025)), write(sine440.subarray(11025)), write()])
  is(out.length, sine440.length, 'length preserved')
  ok(out.every((v, i) => v === sine440[i]), 'every sample identical')
})

test('output stays bounded', () => {
  let out = phaseLock(sine440, { ratio: 1.5 })
  ok(rms(out) < 1.2, `rms ${rms(out).toFixed(3)} should be < 1.2`)
})

test('invalid ratios throw', () => {
  for (let ratio of [0, -1, NaN, Infinity]) {
    throws(() => phaseLock(sine440, { ratio }), /ratio/, `batch rejects ratio=${ratio}`)
    throws(() => phaseLock({ ratio }),           /ratio/, `stream rejects ratio=${ratio}`)
    throws(() => pitchShift(sine440, { ratio }), /ratio/, `pitchShift batch rejects ratio=${ratio}`)
    throws(() => pitchShift({ ratio }),          /ratio/, `pitchShift stream rejects ratio=${ratio}`)
  }
})

run()
