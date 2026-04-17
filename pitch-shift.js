import {
  createChannelWriter, isChannelArray, mapInput, normalizeOptionsInput,
  passThroughWriter, resolveRatio,
} from './util.js'
import formant from './formant-shift.js'
import ola from './ola.js'
import vocoder from './vocoder.js'
import phaseLock from './phase-lock.js'
import transient from './transient.js'
import psola from './psola.js'
import wsola from './wsola.js'
import granular from './granular.js'
import paulstretch from './paulstretch.js'
import sms from './sms.js'
import hpss from './hpss.js'
import sample from './sample.js'
import hybrid from './hybrid.js'

function selectMethod(opts) {
  if (typeof opts?.method === 'function') {
    return { fn: opts.method, name: opts.method.name || 'custom', reason: 'explicit-method' }
  }
  switch (opts?.method) {
    case 'ola': return { fn: ola, name: 'ola', reason: 'explicit-method' }
    case 'vocoder': return { fn: vocoder, name: 'vocoder', reason: 'explicit-method' }
    case 'phase-lock':
    case 'phaseLock': return { fn: phaseLock, name: 'phaseLock', reason: 'explicit-method' }
    case 'transient': return { fn: transient, name: 'transient', reason: 'explicit-method' }
    case 'formant': return { fn: formant, name: 'formant', reason: 'explicit-method' }
    case 'psola': return { fn: psola, name: 'psola', reason: 'explicit-method' }
    case 'wsola': return { fn: wsola, name: 'wsola', reason: 'explicit-method' }
    case 'granular': return { fn: granular, name: 'granular', reason: 'explicit-method' }
    case 'paulstretch': return { fn: paulstretch, name: 'paulstretch', reason: 'explicit-method' }
    case 'sms': return { fn: sms, name: 'sms', reason: 'explicit-method' }
    case 'hpss': return { fn: hpss, name: 'hpss', reason: 'explicit-method' }
    case 'sample': return { fn: sample, name: 'sample', reason: 'explicit-method' }
    case 'hybrid': return { fn: hybrid, name: 'hybrid', reason: 'explicit-method' }
  }
  switch (opts?.content) {
    case 'voice':
    case 'speech': return { fn: psola, name: 'psola', reason: `content:${opts.content}` }
    case 'tonal': return { fn: sms, name: 'sms', reason: 'content:tonal' }
    default: return { fn: transient, name: 'transient', reason: 'fallback:transient' }
  }
}

function notifyDecision(opts, params, decision) {
  if (typeof opts?.onDecision !== 'function') return
  opts.onDecision({
    method: decision.name,
    reason: decision.reason,
    ratio: params.ratio,
    semitones: params.semitones,
    content: opts?.content,
    formant: !!opts?.formant,
  })
}

function shiftAuto(data, opts) {
  let { ratio } = resolveRatio(opts)
  if (opts?.formant) {
    notifyDecision(opts, { ratio, semitones: opts?.semitones ?? 0 }, { name: 'formant', reason: 'formant:true' })
    return formant(data, opts)
  }
  let decision = selectMethod(opts)
  notifyDecision(opts, { ratio, semitones: opts?.semitones ?? 0 }, decision)
  return decision.fn(data, opts)
}

function createWriter(opts) {
  let { ratio } = resolveRatio(opts)
  if (opts?.formant) {
    notifyDecision(opts, { ratio, semitones: opts?.semitones ?? 0 }, { name: 'formant', reason: 'formant:true' })
    return formant(opts)
  }
  let decision = selectMethod(opts)
  notifyDecision(opts, { ratio, semitones: opts?.semitones ?? 0 }, decision)
  let writer = decision.fn(opts)
  if (typeof writer !== 'function') {
    throw new TypeError('pitchShift: selected streaming method must return a writer')
  }
  return writer
}

export default function pitchShift(data, opts) {
  if (data instanceof Float32Array || isChannelArray(data)) {
    return mapInput(data, shiftAuto, opts)
  }
  opts = normalizeOptionsInput(data)
  let { ratio } = resolveRatio(opts)
  if (ratio === 1) return createChannelWriter(() => passThroughWriter())
  return createChannelWriter(() => createWriter(opts))
}
