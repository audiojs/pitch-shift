import {
  createChannelWriter, isChannelArray, mapInput, normalizeOptionsInput,
  passThroughWriter, resolveRatio,
} from '@audio/shift-core'
import formant from '@audio/shift-formant'
import ola from '@audio/shift-ola'
import vocoder from '@audio/shift-pvoc'
import phaseLock from '@audio/shift-pvoc-lock'
import transient from '@audio/shift-transient'
import psola from '@audio/shift-psola'
import wsola from '@audio/shift-wsola'
import granular from '@audio/shift-granular'
import paulstretch from '@audio/shift-paulstretch'
import sms from '@audio/shift-sms'
import hpss from '@audio/shift-hpss'
import sample from '@audio/shift-sample'
import hybrid from '@audio/shift-hybrid'

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
