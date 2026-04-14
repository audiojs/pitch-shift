// Canonical synthetic test signals for pitch-shift quality assessment.
// Each fixture targets a specific property we want to measure rigorously.
// Synthetic signals provide ground truth that real audio cannot.

const PI2 = Math.PI * 2

export function sine(freq, duration, sampleRate) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let w = PI2 * freq / sampleRate
  for (let i = 0; i < n; i++) out[i] = Math.sin(w * i)
  return out
}

// Additive chord — 3 partials at harmonic ratios. Tests partial tracking: after shift,
// all partials should move in the same ratio (preserving interval structure).
export function sineChord(f0, duration, sampleRate, ratios = [1, 1.25, 1.5]) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let amp = 1 / ratios.length
  for (let r of ratios) {
    let w = PI2 * f0 * r / sampleRate
    for (let i = 0; i < n; i++) out[i] += amp * Math.sin(w * i)
  }
  return out
}

// Logarithmic sine sweep from f0 to f1. Aliasing profile: when shifted, out-of-band energy
// (above sampleRate/2 in source domain) reveals anti-alias quality of the stride-read.
export function chirp(f0, f1, duration, sampleRate) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let k = Math.log(f1 / f0) / duration
  let phase = 0
  let prev = 0
  for (let i = 0; i < n; i++) {
    let t = i / sampleRate
    let f = f0 * Math.exp(k * t)
    phase += PI2 * ((f + prev) * 0.5) / sampleRate
    prev = f
    out[i] = Math.sin(phase)
  }
  return out
}

// Dirac impulse train. Ground-truth transient preservation: output should still have sharp
// pulses, and the spacing after shift tells us how well pitch-marks land.
export function diracTrain(period, duration, sampleRate) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  for (let i = 0; i < n; i += period) out[i] = 1
  return out
}

// Karplus-Strong plucked string. Sharp attack + decaying harmonic tail — a compact stand-in
// for transient-plus-tonal material, with a ground-truth fundamental.
export function karplusStrong(freq, duration, sampleRate, decay = 0.996, seed = 1) {
  let period = Math.max(2, Math.round(sampleRate / freq))
  let n = Math.floor(duration * sampleRate)
  let buf = new Float32Array(period)
  let s = seed >>> 0
  for (let i = 0; i < period; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    buf[i] = (s / 0xffffffff) * 2 - 1
  }
  let out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let j = i % period
    let next = (j + 1) % period
    let v = decay * 0.5 * (buf[j] + buf[next])
    out[i] = buf[j]
    buf[j] = v
  }
  let peak = 0
  for (let i = 0; i < n; i++) if (Math.abs(out[i]) > peak) peak = Math.abs(out[i])
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak
  return out
}

// Synthetic vowel — bandlimited sawtooth at f0 excited by second-order resonant filters
// at formant frequencies. Formants are independent of pitch, so a formant-preserving shifter
// must keep the envelope peaks at the same absolute Hz after pitching.
export function vowel(f0, formants, duration, sampleRate) {
  let n = Math.floor(duration * sampleRate)
  let src = new Float32Array(n)
  let nHarm = Math.floor((sampleRate / 2) / f0)
  for (let h = 1; h <= nHarm; h++) {
    let w = PI2 * f0 * h / sampleRate
    let amp = 1 / h
    for (let i = 0; i < n; i++) src[i] += amp * Math.sin(w * i)
  }
  let out = new Float32Array(n)
  out.set(src)
  for (let { freq, bw } of formants) {
    let r = Math.exp(-Math.PI * bw / sampleRate)
    let theta = PI2 * freq / sampleRate
    let a1 = -2 * r * Math.cos(theta)
    let a2 = r * r
    let b0 = 1 - r
    let y1 = 0, y2 = 0
    for (let i = 0; i < n; i++) {
      let y = b0 * out[i] - a1 * y1 - a2 * y2
      y2 = y1
      y1 = y
      out[i] = y
    }
  }
  let peak = 0
  for (let i = 0; i < n; i++) if (Math.abs(out[i]) > peak) peak = Math.abs(out[i])
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak
  return out
}

// Amplitude-modulated sine (tremolo). Ground truth: output should preserve the modulation
// envelope. Phase-coherence failures smear the envelope.
export function amSine(carrier, modRate, modDepth, duration, sampleRate) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let wc = PI2 * carrier / sampleRate
  let wm = PI2 * modRate / sampleRate
  for (let i = 0; i < n; i++) {
    out[i] = (1 - modDepth + modDepth * (0.5 + 0.5 * Math.cos(wm * i))) * Math.sin(wc * i)
  }
  return out
}

// White noise burst — uniform spectrum stress test. Used for temporal smearing and for
// exercising scatter collisions on a dense spectrum.
export function noiseBurst(duration, sampleRate, seed = 1) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = ((s / 0xffffffff) * 2 - 1)
  }
  return out
}

// Choir — stacked detuned vowel voices with small per-voice time offsets. Models humanized
// unison singing, providing a formant-rich harmonic fixture whose ground-truth f0 and
// formant centers are known. A formant-preserving shifter must keep the formant peaks at
// the same absolute Hz while the fundamental moves.
export function choir(f0, formants, duration, sampleRate, voices = 4, detuneCents = 8) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  for (let v = 0; v < voices; v++) {
    let cents = (v - (voices - 1) / 2) * detuneCents
    let fv = f0 * Math.pow(2, cents / 1200)
    let voice = vowel(fv, formants, duration, sampleRate)
    let offset = Math.floor((v * 0.003) * sampleRate)
    for (let i = 0; i < n - offset; i++) out[i + offset] += voice[i] / voices
  }
  let peak = 0
  for (let i = 0; i < n; i++) if (Math.abs(out[i]) > peak) peak = Math.abs(out[i])
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak
  return out
}

// Kick drum — sinusoidal body with exponential frequency drop (sweep from ~3·f0 to f0) and
// exponential amplitude decay. Canonical 808-style atom with a precise attack at i=0.
export function kick(duration, sampleRate, f0 = 55) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let phase = 0
  let ta = 0.015
  let td = 0.12
  for (let i = 0; i < n; i++) {
    let t = i / sampleRate
    let f = f0 * (1 + 2 * Math.exp(-t / ta))
    phase += PI2 * f / sampleRate
    out[i] = Math.exp(-t / td) * Math.sin(phase)
  }
  return out
}

// Snare — resonant bandpass-filtered noise plus a short body tone. Seeded LCG for determinism.
export function snare(duration, sampleRate, seed = 2) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let s = seed >>> 0
  let r = 0.98
  let theta = PI2 * 180 / sampleRate
  let a1 = -2 * r * Math.cos(theta)
  let a2 = r * r
  let y1 = 0, y2 = 0
  for (let i = 0; i < n; i++) {
    let t = i / sampleRate
    s = (s * 1664525 + 1013904223) >>> 0
    let noise = (s / 0xffffffff) * 2 - 1
    let y = noise - a1 * y1 - a2 * y2
    y2 = y1
    y1 = y
    let env = Math.exp(-t * 18)
    out[i] = env * (0.6 * noise + 0.4 * y)
  }
  return out
}

// Hi-hat — highpass-shaped short noise burst. Models the brightest, most transient percussion.
export function hihat(duration, sampleRate, seed = 3) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let s = seed >>> 0
  let xp = 0, yp = 0
  for (let i = 0; i < n; i++) {
    let t = i / sampleRate
    s = (s * 1664525 + 1013904223) >>> 0
    let x = (s / 0xffffffff) * 2 - 1
    let y = 0.95 * (yp + x - xp)
    xp = x
    yp = y
    let env = Math.exp(-t * 45)
    out[i] = env * y
  }
  return out
}

// Drum pattern — place drum atoms at specified onset times (seconds). Ground truth:
// onset positions must survive a pitch shift exactly (pitch-shift is not time-stretch).
// Example pattern: four-on-the-floor with backbeat snare.
// `pattern` is [{ type: 'kick'|'snare'|'hat', time: seconds }]
export function drumPattern(duration, sampleRate, pattern) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let mix = (sig, start) => {
    let i0 = Math.floor(start * sampleRate)
    let len = Math.min(sig.length, n - i0)
    for (let i = 0; i < len; i++) out[i0 + i] += sig[i]
  }
  for (let { type, time } of pattern) {
    if (type === 'kick')  mix(kick(0.25, sampleRate), time)
    else if (type === 'snare') mix(snare(0.18, sampleRate), time)
    else if (type === 'hat')   mix(hihat(0.06, sampleRate), time)
  }
  let peak = 0
  for (let i = 0; i < n; i++) if (Math.abs(out[i]) > peak) peak = Math.abs(out[i])
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak
  return out
}

// Canonical rock beat (2 bars at 120 BPM = 4 s). Used as a drop-in perc fixture.
export function rockBeat(duration, sampleRate, bpm = 120) {
  let beat = 60 / bpm
  let sixteenth = beat / 4
  let pattern = []
  for (let bar = 0; bar * beat * 4 < duration; bar++) {
    let t0 = bar * beat * 4
    // Kick on 1 and 3
    pattern.push({ type: 'kick', time: t0 })
    pattern.push({ type: 'kick', time: t0 + beat * 2 })
    // Snare on 2 and 4
    pattern.push({ type: 'snare', time: t0 + beat })
    pattern.push({ type: 'snare', time: t0 + beat * 3 })
    // Hi-hat eighths
    for (let i = 0; i < 8; i++) pattern.push({ type: 'hat', time: t0 + i * sixteenth * 2 })
  }
  return drumPattern(duration, sampleRate, pattern)
}

// Synth arpeggio — sequence of Karplus-Strong plucks at known MIDI pitches. Ground truth:
// each note's f0 must shift to `f · ratio`, note boundaries must be preserved in time.
export function arpeggio(midiNotes, noteDuration, sampleRate) {
  let per = Math.floor(noteDuration * sampleRate)
  let n = per * midiNotes.length
  let out = new Float32Array(n)
  for (let k = 0; k < midiNotes.length; k++) {
    let f = 440 * Math.pow(2, (midiNotes[k] - 69) / 12)
    let note = karplusStrong(f, noteDuration, sampleRate, 0.996, k + 1)
    for (let i = 0; i < per; i++) {
      let t = i / sampleRate
      let env = (1 - Math.exp(-t / 0.005)) * Math.exp(-t / (noteDuration * 0.8))
      out[k * per + i] = note[i] * env
    }
  }
  let peak = 0
  for (let i = 0; i < n; i++) if (Math.abs(out[i]) > peak) peak = Math.abs(out[i])
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak
  return out
}

// Flute — near-pure sinusoid dominated by the fundamental, faint 2nd/3rd harmonics, small
// 5 Hz vibrato, faint breath-noise floor. Stand-in for a soft tonal wind instrument with
// a ground-truth f0.
export function flute(freq, duration, sampleRate, seed = 4) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  let s = seed >>> 0
  let phase = 0
  let vibRate = 5
  let vibDepth = freq * 0.005
  for (let i = 0; i < n; i++) {
    let t = i / sampleRate
    let f = freq + vibDepth * Math.sin(PI2 * vibRate * t)
    phase += PI2 * f / sampleRate
    let tone = Math.sin(phase) + 0.15 * Math.sin(2 * phase) + 0.04 * Math.sin(3 * phase)
    s = (s * 1664525 + 1013904223) >>> 0
    let breath = ((s / 0xffffffff) * 2 - 1) * 0.04
    let attack = Math.min(1, t / 0.05)
    let release = Math.min(1, (duration - t) / 0.05)
    out[i] = attack * release * (tone / 1.19 + breath)
  }
  return out
}
