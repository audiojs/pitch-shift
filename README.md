# pitch-shift [![test](https://github.com/audiojs/pitch-shift/actions/workflows/test.yml/badge.svg)](https://github.com/audiojs/pitch-shift/actions/workflows/test.yml) [![npm](https://img.shields.io/npm/v/pitch-shift?color=white)](https://npmjs.org/pitch-shift) [![demo](https://img.shields.io/badge/demo-live-black)](https://audiojs.github.io/pitch-shift/demo)

Canonical pitch-shifting algorithms in functional JavaScript.<br>
_Frequency-domain_: vocoder, phaseLock, transient, formant, sms, hpss.<br>
_Time-domain_: ola, wsola, psola, granular.<br>
Consistent unified API: batch, stream, multi-channel.
Part of the audiojs ecosystem.

## Install

```bash
npm install pitch-shift
```

## Usage

```js
import transient from 'pitch-shift/transient.js'

// Batch
let pitched = transient(audio, { semitones: 5 })

// Stream
let write = transient({ ratio: 1.5 })
let output = write(inputBlock)
let tail = write()  // flush

// Stereo
let [L, R] = transient([left, right], { ratio: 1.5 })
```

## Algorithms

Frequency-domain algorithms shift bins natively; time-domain algorithms use their namesake stretcher from [time-stretch](https://github.com/audiojs/time-stretch) + sinc resample.

| Algorithm | Best for | Preserves | Destroys |
|-----------|----------|-----------|----------|
| `ola` | Baseline | pitch, envelope | formants, transients, phase coherence |
| `vocoder` | Simple tonal | partial pitch, long-horizon phase | transients ("phasiness"), formants |
| `phaseLock` | General music ★ | phase coherence around peaks, partials | transients (less than vocoder), formants |
| `transient` | Music + percussion | phaseLock + attack localization | formants; misses quiet transients |
| `psola` | Speech, mono voice | waveform shape, formants, naturalness | polyphony, unvoiced regions |
| `wsola` | Speech, low-latency | waveform shape, attacks | formants, phase coherence |
| `granular` | Creative textures | grain-local timbre | pitch accuracy, smooth envelopes |
| `formant` | Voice (no chipmunk) | formant envelope, vocal-tract character | transients; cepstral ringing on sparse spectra |
| `paulstretch` | Ambient, extreme shifts | magnitude-spectrum statistics | phase, transients, rhythm — by design |
| `sms` | Harmonic/tonal | formant envelope, harmonic structure | transients, noise textures, polyphony |
| `hpss` | Mixed music (drums+tonal) | percussive onsets + harmonic pitch | signal quality (mask leakage) |
| `sample` | Sampler/tracker playback | waveform identity, formants | time (higher pitch = shorter clip) |
| `hybrid` | Mixed dynamic material | tonal phase coherence + attack shape | CPU (≈2×), formants |

Default export: `voice`/`speech` → `psola`, `tonal` → `sms`, else → `transient`.

### Measured quality

Measured on synthetic fixtures with exact ground truth. **shift** = log-magnitude distance to the canonical shifted reference — lower is better. Run `npm run quality` for live numbers.

| Algorithm | f0 err | THD% | alias | stream corr | cent err | onset err | attack corr | formant dist | phase coh | shift |
|-----------|-------:|-----:|------:|------------:|---------:|----------:|------------:|-------------:|----------:|------:|
| `hpss` | 0.00 | 0.0 | 0.052 | 1.000 | 0.007 | 0.000 | 0.996 | 1.267 | 0.922 | **1.464** |
| `vocoder` | 0.00 | 0.0 | 0.000 | 1.000 | 0.006 | 0.000 | 0.983 | 1.343 | 0.922 | 1.491 |
| `formant` | 0.00 | 0.0 | 0.000 | 1.000 | 0.061 | 0.000 | 0.988 | **0.921** | 0.980 | 1.593 |
| `sample` | 2.50 | 0.1 | 0.007 | 1.000 | 0.003 | 0.000 | 0.951 | 2.245 | 0.170 | 1.655 |
| `wsola` | 1.00 | 0.2 | 0.005 | 1.000 | 0.003 | 0.000 | **0.995** | 2.345 | 0.866 | 1.672 |
| `sms` | 0.00 | 0.0 | 0.002 | 1.000 | 0.001 | 0.000 | 0.953 | 2.028 | 0.922 | 1.761 |
| `psola` | 0.66 | 0.2 | 0.005 | 1.000 | 0.003 | 0.000 | 0.941 | 2.340 | **0.998** | 1.767 |
| `phaseLock` | 0.00 | 0.0 | 0.000 | 1.000 | 0.012 | 0.000 | 0.988 | 1.623 | 0.991 | 1.775 |
| `pitchShift` (auto) | 0.00 | 0.0 | 0.000 | 1.000 | 0.012 | 0.000 | 0.988 | 1.619 | 0.991 | 1.781 |
| `transient` | 0.00 | 0.0 | 0.000 | 1.000 | 0.012 | 0.000 | 0.988 | 1.619 | 0.991 | 1.781 |
| `granular` | 0.95 | 0.2 | 0.005 | 1.000 | 0.019 | 0.000 | 0.995 | 2.796 | 0.945 | 1.905 |
| `hybrid` | 0.00 | 0.0 | 0.000 | 1.000 | 0.004 | 0.000 | 0.988 | 2.538 | 0.879 | 1.925 |
| `ola` | 39.59 | 0.1 | 0.005 | 1.000 | 0.042 | 0.388 | 0.977 | 2.360 | 0.992 | 2.050 |
| `paulstretch` | 0.00 | 0.3 | 0.232 | — | 0.005 | 0.000 | 0.954 | 7.113 | — | 2.339 |

<details><summary>Column definitions</summary>

- **f0 err** (Hz) — pitch accuracy shifting 440→660 Hz sine.
- **THD%** — harmonic distortion on shifted pure sine.
- **alias** — energy above Nyquist when shifting 14 kHz ×2.
- **stream corr** — streaming vs batch correlation. `—` = decorrelates by design.
- **cent err** — spectral centroid ratio error on a 3-partial chord.
- **onset err** — impulse-train period error after shift.
- **attack corr** — plucked-string attack envelope correlation.
- **formant dist** — cepstral envelope distance on synthetic vowel. Lower = formants preserved.
- **phase coh** — AM-envelope coherence on 5 Hz tremolo. `—` for `paulstretch` (non-deterministic).
- **shift** — log-magnitude distance to canonical shifted reference, averaged over four fixtures. Bold = leader.

</details>

### Options

All algorithms accept:

| Option | Default | Description |
|--------|---------|-------------|
| `ratio` | `1` | Pitch shift ratio (1.5 = +7 semitones, 2 = +1 octave) |
| `semitones` | from ratio | Pitch shift in semitones (alternative to `ratio`) |
| `frameSize` | `2048` | Frame size in samples |
| `hopSize` | `frameSize/4` | Hop between frames |

Default export (`pitchShift`) additionally accepts:

| Option | Default | Description |
|--------|---------|-------------|
| `content` | `music` | Auto-select hint: `music`, `voice`/`speech`, `tonal` |
| `method` | auto | Force a specific algorithm by name |
| `formant` | `false` | Wrap selected algorithm in formant preservation |

Algorithm-specific:

- **`transient`**: `transientThreshold` (`1.5`) — z-score over log-flux EMA
- **`psola`**: `sampleRate`, `minFreq` (`70`), `maxFreq` (`600`)
- **`wsola`**: `tolerance` (`frameSize/4`) — similarity search radius
- **`formant`**: `envelopeWidth` (`max(8, N/64)`) — cepstrum lifter cutoff
- **`sms`**: `maxTracks` (`Infinity`), `minMag` (`1e-4`)
- **`hpss`**: `hpssTimeWidth` (`17`), `hpssFreqWidth` (`17`), `hpssPower` (`2`)
- **`sample`**: `sincRadius` (`8`) — windowed-sinc half-width
- **`hybrid`**: `hybridThreshold` (`0.8`) — spectral-flux z-score for WSOLA blend

### Variable pitch

Frequency-domain algorithms + `sample` accept time-varying `ratio` — a function `(t) => ratio` or `Float32Array`. Time-domain algorithms (`ola`, `wsola`, `psola`, `granular`, `hybrid`) apply a single global ratio.

```js
// Vibrato: ±10% at 5 Hz
let vibrato = phaseLock(audio, {
  ratio: (t) => 1 + 0.1 * Math.sin(2 * Math.PI * 5 * t),
  sampleRate: 44100,
})
```

#### Pitch correction

Combine with a pitch detector: detect per-frame f0, snap to target scale, pass as `ratio` function. Use `formant` for natural voice, `phaseLock` for hard-tune effect, `sms` for harmonic instruments.

```js
import { yin } from 'pitch-detection'
import { formant } from 'pitch-shift'

let hop = 512, sr = 44100
let pitchFrames = []
for (let i = 0; i + 2048 <= audio.length; i += hop) {
  let r = yin(audio.subarray(i, i + 2048), { fs: sr })
  pitchFrames.push(r ? { freq: r.freq, clarity: r.clarity } : null)
}

let scale = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88]
let snap = (f) => scale.reduce((a, b) =>
  Math.abs(Math.log2(b / f)) < Math.abs(Math.log2(a / f)) ? b : a
)

let corrected = formant(audio, {
  ratio: (t) => {
    let p = pitchFrames[Math.min(Math.round(t * sr / hop), pitchFrames.length - 1)]
    return (!p || p.clarity < 0.5) ? 1 : snap(p.freq) / p.freq
  },
  sampleRate: sr,
})
```

## Quality Tools

```bash
npm test          # correctness
npm run quality   # measured metrics
npm run bench     # performance
```

## Dependencies

- [time-stretch](https://github.com/audiojs/time-stretch) — Time-domain stretchers (WSOLA, PSOLA)
- [fourier-transform](https://github.com/audiojs/fourier-transform) — FFT
- [window-function](https://github.com/audiojs/window-function) — Hann windowing

## Migration from v0.0.0

Previously held by [mikolalysenko/pitch-shift](https://github.com/mikolalysenko/pitch-shift) (2013, v0.0.0) — a single WSOLA/TD-PSOLA implementation. Available here as [`wsola`](#algorithms) or [`psola`](#algorithms) with batch, streaming, and multi-channel support.

```js
// v0.0.0 (old)
var shifter = require('pitch-shift')(onData, t => ratio, { frameSize: 2048 })
shifter.feed(float32Array)

// v1 (this package)
import { wsola } from 'pitch-shift'
let write = wsola({ ratio })
let out = write(float32Array)
let tail = write()  // flush
```

## Related

- [time-stretch](https://github.com/audiojs/time-stretch) — Time stretching
- [audio-filter](https://github.com/audiojs/audio-filter) — Audio filters


<p align="center"><a href="./license.md">MIT</a> · <a href="https://github.com/krishnized/license">ॐ</a></p>
