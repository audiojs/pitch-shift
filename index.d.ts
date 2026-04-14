export type PitchShiftBuffer = Float32Array
export type PitchShiftChannels = Float32Array[]
export type PitchShiftInput = PitchShiftBuffer | PitchShiftChannels

type Writer = (chunk?: PitchShiftInput) => PitchShiftInput

export interface PitchShiftDecision {
  method: string
  reason: string
  ratio: number
  semitones: number
  content?: 'music' | 'voice' | 'speech' | 'tonal'
  formant: boolean
}

export type PitchShiftMethodName =
  | 'ola'
  | 'vocoder'
  | 'phaseLock'
  | 'phase-lock'
  | 'transient'
  | 'psola'
  | 'wsola'
  | 'granular'
  | 'paulstretch'
  | 'sms'
  | 'hpss'
  | 'sample'
  | 'hybrid'
  | 'formant'

export type PitchShiftMethod =
  | PitchShiftMethodName
  | {
      (data: Float32Array, opts?: PitchShiftOpts): Float32Array
      (data: Float32Array[], opts?: PitchShiftOpts): Float32Array[]
      (opts?: PitchShiftOpts): Writer
    }

export type PitchRatio = number | ((timeSeconds: number) => number) | Float32Array

export interface PitchShiftOpts {
  ratio?: PitchRatio
  ratioDuration?: number
  semitones?: number
  formant?: boolean
  content?: 'music' | 'voice' | 'speech' | 'tonal'
  method?: PitchShiftMethod
  onDecision?: (decision: PitchShiftDecision) => void
  frameSize?: number
  hopSize?: number
  sampleRate?: number
  transientThreshold?: number
  minFreq?: number
  maxFreq?: number
  envelopeWidth?: number
  maxTracks?: number
  minMag?: number
  tolerance?: number
  hpssTimeWidth?: number
  hpssFreqWidth?: number
  hpssPower?: number
  sincRadius?: number
  hybridThreshold?: number
}

type PitchShiftFn = {
  (data: Float32Array, opts?: PitchShiftOpts): Float32Array
  (data: Float32Array[], opts?: PitchShiftOpts): Float32Array[]
  (opts?: PitchShiftOpts): Writer
}

export declare const ola: PitchShiftFn
export declare const vocoder: PitchShiftFn
export declare const phaseLock: PitchShiftFn
export declare const transient: PitchShiftFn
export declare const psola: PitchShiftFn
export declare const wsola: PitchShiftFn
export declare const granular: PitchShiftFn
export declare const formant: PitchShiftFn
export declare const paulstretch: PitchShiftFn
export declare const sms: PitchShiftFn
export declare const hpss: PitchShiftFn
export declare const sample: PitchShiftFn
export declare const hybrid: PitchShiftFn

export declare const pitchShift: PitchShiftFn
export default pitchShift
