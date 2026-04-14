import pitchShift, { ola, vocoder, phaseLock, transient, psola, wsola, formant, granular, paulstretch, sms, hpss, sample, hybrid } from './index.js'
import assert from 'assert'

function generateSine(freq, duration, sampleRate) {
  let samples = Math.floor(duration * sampleRate)
  let data = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    data[i] = Math.sin(2 * Math.PI * freq * i / sampleRate)
  }
  return data
}

function concat(chunks) {
  let len = 0
  for (let chunk of chunks) len += chunk.length

  let out = new Float32Array(len)
  let offset = 0
  for (let chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function concatChannels(chunks) {
  let channelCount = chunks[0]?.length ?? 0
  let out = new Array(channelCount)
  for (let channel = 0; channel < channelCount; channel++) {
    out[channel] = concat(chunks.map((chunk) => chunk[channel]))
  }
  return out
}

function rms(data) {
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / Math.max(1, data.length))
}

function correlation(a, b) {
  assert.equal(a.length, b.length, 'correlation inputs must have same length')
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return dot / Math.sqrt(Math.max(1e-12, aa * bb))
}

function estimateFrequency(data, sampleRate) {
  let start = Math.floor(data.length * 0.2)
  let end = Math.floor(data.length * 0.8)
  let crossings = 0
  let prev = data[start]
  for (let i = start + 1; i < end; i++) {
    let curr = data[i]
    if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) crossings++
    prev = curr
  }
  let duration = (end - start) / sampleRate
  return crossings / (2 * duration)
}

function runChunked(writer, data, boundaries) {
  let parts = []
  let start = 0
  for (let boundary of boundaries) {
    parts.push(writer(data.subarray(start, boundary)))
    start = boundary
  }
  if (start < data.length) parts.push(writer(data.subarray(start)))
  parts.push(writer())
  return parts
}

console.log('Testing pitch-shift algorithms...')

// Test data
let sampleRate = 44100
let sine440 = generateSine(440, 0.5, sampleRate)
let sine660 = generateSine(660, 0.5, sampleRate)

// Test 0: ola
console.log('  ola...')
let ol = ola(sine440, { ratio: 1.5 })
assert(ol instanceof Float32Array, 'ola should return Float32Array')
assert(ol.length === sine440.length, 'ola should preserve length')

// Test 1: vocoder
console.log('  vocoder...')
let v = vocoder(sine440, { ratio: 1.5 })
assert(v instanceof Float32Array, 'vocoder should return Float32Array')
assert(v.length === sine440.length, 'vocoder should preserve length')

// Test 2: phaseLock
console.log('  phaseLock...')
let pl = phaseLock(sine440, { ratio: 1.5 })
assert(pl instanceof Float32Array, 'phaseLock should return Float32Array')
assert(pl.length === sine440.length, 'phaseLock should preserve length')

// Test 3: transient
console.log('  transient...')
let tr = transient(sine440, { ratio: 1.5, transientThreshold: 1.5 })
assert(tr instanceof Float32Array, 'transient should return Float32Array')
assert(tr.length === sine440.length, 'transient should preserve length')

// Test 4: psola
console.log('  psola...')
let ps = psola(sine440, { ratio: 1.5, sampleRate })
assert(ps instanceof Float32Array, 'psola should return Float32Array')
assert(ps.length === sine440.length, 'psola should preserve length')

// Test 5: formant
console.log('  formant...')
let fm = formant(sine440, { ratio: 1.5 })
assert(fm instanceof Float32Array, 'formant should return Float32Array')
assert(fm.length === sine440.length, 'formant should preserve length')

// Test 6: granular
console.log('  granular...')
let gr = granular(sine440, { ratio: 1.5 })
assert(gr instanceof Float32Array, 'granular should return Float32Array')
assert(gr.length === sine440.length, 'granular should preserve length')

// Test 7: paulstretch
console.log('  paulstretch...')
let ps2 = paulstretch(sine440, { ratio: 1.5 })
assert(ps2 instanceof Float32Array, 'paulstretch should return Float32Array')
assert(ps2.length === sine440.length, 'paulstretch should preserve length')

// Test 8: sms
console.log('  sms...')
let sm = sms(sine440, { ratio: 1.5 })
assert(sm instanceof Float32Array, 'sms should return Float32Array')
assert(sm.length === sine440.length, 'sms should preserve length')

// Test 8b: hpss
console.log('  hpss...')
let hp = hpss(sine440, { ratio: 1.5 })
assert(hp instanceof Float32Array, 'hpss should return Float32Array')
assert(hp.length === sine440.length, 'hpss should preserve length')

// Test 8c: sample
console.log('  sample...')
let sp = sample(sine440, { ratio: 1.5 })
assert(sp instanceof Float32Array, 'sample should return Float32Array')
assert(sp.length === sine440.length, 'sample should preserve length')

// Test 8d: hybrid
console.log('  hybrid...')
let hy = hybrid(sine440, { ratio: 1.5 })
assert(hy instanceof Float32Array, 'hybrid should return Float32Array')
assert(hy.length === sine440.length, 'hybrid should preserve length')

// Test 8e: variable ratio (time-varying pitch curve) on phaseLock and sample
console.log('  variable ratio...')
let curve = (t) => 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t)  // 3 Hz vibrato ±10%
let plVar = phaseLock(sine440, { ratio: curve, sampleRate })
assert(plVar instanceof Float32Array, 'phaseLock variable ratio should return Float32Array')
assert(plVar.length === sine440.length, 'phaseLock variable ratio should preserve length')
assert(rms(plVar) > 0.1, 'phaseLock variable ratio output should be non-silent')
let spVar = sample(sine440, { ratio: curve, sampleRate })
assert(spVar instanceof Float32Array, 'sample variable ratio should return Float32Array')
assert(spVar.length === sine440.length, 'sample variable ratio should preserve length')
assert(rms(spVar) > 0.1, 'sample variable ratio output should be non-silent')
// Algorithms that do not support variable ratio must throw a clear error
for (let [name, fn] of [['vocoder', vocoder], ['transient', transient], ['psola', psola]]) {
  assert.throws(() => fn(sine440, { ratio: curve, sampleRate }), /variable|supported/, `${name} should reject function ratio`)
}

// Test 9: default auto selector
console.log('  default pitchShift...')
let auto = pitchShift(sine440, { ratio: 1.5 })
assert(auto instanceof Float32Array, 'default pitchShift should return Float32Array')
assert(auto.length === sine440.length, 'default pitchShift should preserve length')

// Test streaming API
console.log('  streaming API...')
let write = phaseLock({ ratio: 1.5 })
let chunk1 = sine440.subarray(0, 11025)
let chunk2 = sine440.subarray(11025)
let out1 = write(chunk1)
let out2 = write(chunk2)
let tail = write()
assert(out1 instanceof Float32Array, 'streaming write should return Float32Array')
assert(out2 instanceof Float32Array, 'streaming write should return Float32Array')
assert(tail instanceof Float32Array, 'streaming flush should return Float32Array')
assert(concat([out1, out2, tail]).length === sine440.length, 'streaming API should preserve total length')

// Test default streaming API
console.log('  default streaming API...')
let autoWrite = pitchShift({ ratio: 1.5 })
assert.equal(typeof autoWrite, 'function', 'default pitchShift writer should be a function')
let autoChunks = [autoWrite(chunk1), autoWrite(chunk2), autoWrite()]
assert(concat(autoChunks).length === sine440.length, 'default pitchShift streaming should preserve total length')

// Test chunk boundary stability
console.log('  chunk boundary stability...')
let phaseBatch = phaseLock(sine440, { ratio: 1.5 })
for (let boundaries of [[257, 1031, 4097], [512, 2048, 8192], [11025]]) {
  let stream = concat(runChunked(phaseLock({ ratio: 1.5 }), sine440, boundaries))
  assert(stream.length === sine440.length, 'streaming should preserve total length for arbitrary chunk sizes')
  assert(correlation(phaseBatch, stream) > 0.85, 'streaming output should remain close to batch output across chunk boundaries')
}

// Test pitch accuracy on simple tonal material. Tolerances reflect each algorithm's
// inherent character on a pure sine, measured against the target 660 Hz (440 × 1.5).
// PSOLA is excluded: canonical TD-PSOLA relies on formant structure (grain = filtered
// glottal impulse response) to create the perceived pitch; a bare sine has no formant,
// so PSOLA OLA produces interference at the original fundamental. See scripts/quality.js
// for PSOLA's strength on vowels/voices.
console.log('  pitch accuracy...')
let shifted = phaseLock(sine440, { ratio: 1.5 })
let detectedFreq = estimateFrequency(shifted, sampleRate)
assert(Math.abs(detectedFreq - 660) < 12, 'phaseLock should shift a 440 Hz sine close to 660 Hz')

for (let [name, fn, tol, opts] of [
  ['vocoder',     vocoder,     12, {}],
  ['transient',   transient,   12, {}],
  ['sms',         sms,         12, {}],
  ['hpss',        hpss,        12, {}],
  ['hybrid',      hybrid,      15, {}],
  ['paulstretch', paulstretch, 12, {}],
  ['wsola',       wsola,       20, {}],
  ['granular',    granular,    60, {}],
  ['ola',         ola,         60, {}],
]) {
  let out = fn(sine440, { ratio: 1.5, ...opts })
  let f = estimateFrequency(out, sampleRate)
  assert(Math.abs(f - 660) < tol, `${name} should shift 440 Hz to ~660 Hz (got ${f.toFixed(1)}, tol ${tol})`)
}

// Test auto-selection reporting
console.log('  decision reporting...')
let decision = null
let tonal = pitchShift(sine440, {
  ratio: 1.5,
  content: 'tonal',
  onDecision(value) {
    decision = value
  }
})
assert(tonal instanceof Float32Array, 'default pitchShift tonal output should be Float32Array')
assert.equal(decision?.method, 'sms', 'content=tonal should choose sms')

// Test multi-channel batch and streaming support
console.log('  multi-channel support...')
let stereo = [sine440, sine660]
let stereoBatch = phaseLock(stereo, { ratio: 1.5 })
assert(Array.isArray(stereoBatch), 'multi-channel batch should return an array')
assert.equal(stereoBatch.length, 2, 'multi-channel batch should preserve channel count')
assert(stereoBatch.every((channel, index) => channel instanceof Float32Array && channel.length === stereo[index].length), 'multi-channel batch should preserve channel lengths')

let stereoWriter = phaseLock({ ratio: 1.5 })
let stereoParts = [
  stereoWriter([sine440.subarray(0, 11025), sine660.subarray(0, 11025)]),
  stereoWriter([sine440.subarray(11025), sine660.subarray(11025)]),
  stereoWriter()
]
assert(stereoParts.every(Array.isArray), 'multi-channel streaming should return arrays of channels')
let stereoStream = concatChannels(stereoParts)
assert.equal(stereoStream.length, 2, 'multi-channel streaming should preserve channel count')
assert.equal(stereoStream[0].length, sine440.length, 'left channel should preserve total length')
assert.equal(stereoStream[1].length, sine660.length, 'right channel should preserve total length')

// Test improved resampling stays bounded on hard shifts
console.log('  bounded resampling...')
assert(rms(phaseBatch) < 1.2, 'resampled output should stay bounded in RMS')

// Test identity (ratio = 1)
console.log('  identity (ratio=1)...')
let id = phaseLock(sine440, { ratio: 1 })
assert(id instanceof Float32Array, 'identity should return Float32Array')
assert(id.length === sine440.length, 'identity should preserve length')

// Test streaming identity (ratio = 1)
console.log('  streaming identity (ratio=1)...')
let identityWrite = phaseLock({ ratio: 1 })
let identityChunks = [identityWrite(chunk1), identityWrite(chunk2), identityWrite()]
let identityOut = concat(identityChunks)
assert(identityOut.length === sine440.length, 'streaming identity should preserve total length')
assert.deepStrictEqual(Array.from(identityOut), Array.from(sine440), 'streaming identity should pass audio through unchanged')

// Test invalid ratios
console.log('  invalid ratios...')
for (let ratio of [0, -1, NaN, Infinity]) {
  assert.throws(() => phaseLock(sine440, { ratio }), /ratio/, `batch should reject ratio=${ratio}`)
  assert.throws(() => phaseLock({ ratio }), /ratio/, `stream should reject ratio=${ratio}`)
  assert.throws(() => pitchShift(sine440, { ratio }), /ratio/, `default batch should reject ratio=${ratio}`)
  assert.throws(() => pitchShift({ ratio }), /ratio/, `default stream should reject ratio=${ratio}`)
}

console.log('✓ All tests passed!')
