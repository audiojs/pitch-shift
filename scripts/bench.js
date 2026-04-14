import { performance } from 'node:perf_hooks'
import pitchShift, { ola, vocoder, phaseLock, transient, psola, formant, granular, paulstretch, sms } from '../index.js'

const sampleRate = 44100
const algorithms = [
  { name: 'pitchShift', fn: pitchShift, opts: { ratio: 1.5 } },
  { name: 'ola', fn: ola, opts: { ratio: 1.5 } },
  { name: 'vocoder', fn: vocoder, opts: { ratio: 1.5 } },
  { name: 'phaseLock', fn: phaseLock, opts: { ratio: 1.5 } },
  { name: 'transient', fn: transient, opts: { ratio: 1.5, transientThreshold: 1.5 } },
  { name: 'psola', fn: psola, opts: { ratio: 1.5, sampleRate } },
  { name: 'formant', fn: formant, opts: { ratio: 1.5 } },
  { name: 'granular', fn: granular, opts: { ratio: 1.5 } },
  { name: 'paulstretch', fn: paulstretch, opts: { ratio: 1.5 } },
  { name: 'sms', fn: sms, opts: { ratio: 1.5 } },
]

const sources = [
  { name: 'tone', data: generateTone() },
  { name: 'chord', data: generateChord() },
  { name: 'perc', data: generatePerc() },
]

function generateTone(duration = 1) {
  let samples = Math.floor(duration * sampleRate)
  let out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) out[i] = 0.7 * Math.sin(2 * Math.PI * 440 * i / sampleRate)
  return out
}

function generateChord(duration = 1) {
  let freqs = [261.6, 329.6, 392]
  let samples = Math.floor(duration * sampleRate)
  let out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    for (let freq of freqs) out[i] += Math.sin(2 * Math.PI * freq * i / sampleRate) * (0.6 / freqs.length)
  }
  return out
}

function generatePerc(duration = 1) {
  let samples = Math.floor(duration * sampleRate)
  let out = new Float32Array(samples)
  let hits = 4
  let spacing = Math.floor(samples / hits)
  for (let hit = 0; hit < hits; hit++) {
    let offset = hit * spacing
    let freq = 90 + hit * 25
    let len = Math.min(Math.floor(sampleRate * 0.2), samples - offset)
    for (let i = 0; i < len; i++) {
      let env = Math.exp(-i / (sampleRate * 0.035))
      let noise = (Math.random() * 2 - 1) * Math.exp(-i / (sampleRate * 0.004))
      let body = Math.sin(2 * Math.PI * freq * i / sampleRate) * env
      out[offset + i] += (noise * 0.35 + body * 0.65) * 0.75
    }
  }
  return out
}

function bench(fn, data, opts, iterations = 3) {
  fn(data, opts)
  let total = 0
  for (let i = 0; i < iterations; i++) {
    let start = performance.now()
    fn(data, opts)
    total += performance.now() - start
  }
  return total / iterations
}

console.log('Algorithm\tSource\tAvgMs')
for (let algorithm of algorithms) {
  for (let source of sources) {
    let avg = bench(algorithm.fn, source.data, algorithm.opts)
    console.log(`${algorithm.name}\t${source.name}\t${avg.toFixed(2)}`)
  }
}
