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

| | Domain | Best for | shift |
|---|---|---|---|
| [pitchShift](#pitchshift) | auto | content-aware default | 1.781 |
| [transient](#transient) | STFT | music with percussion ★ | 1.781 |
| [phaseLock](#phaselock) | STFT | general music | 1.775 |
| [vocoder](#vocoder) | STFT | simple tonal | 1.491 |
| [formant](#formant) | STFT | voice (no chipmunk) | 1.593 |
| [hpss](#hpss) | STFT | mixed music (drums+tonal) | **1.464** |
| [sms](#sms) | sinusoidal | harmonic/tonal | 1.761 |
| [paulstretch](#paulstretch) | STFT | ambient, extreme shifts | 2.339 |
| [wsola](#wsola) | time | speech, low-latency | 1.672 |
| [psola](#psola) | time | speech, mono voice | 1.767 |
| [ola](#ola) | time | baseline | 2.050 |
| [granular](#granular) | time | creative textures | 1.905 |
| [sample](#sample) | time | sampler/tracker playback | 1.655 |
| [hybrid](#hybrid) | hybrid | mixed dynamic material | 1.925 |

Frequency-domain algorithms shift bins natively; time-domain algorithms use their namesake stretcher from [time-stretch](https://github.com/audiojs/time-stretch) + sinc resample. **shift** = log-magnitude distance to canonical reference (lower is better). Run `npm run quality` for all metrics.

All algorithms accept `ratio` (1.5 = +7 semitones, 2 = octave), `semitones`, `frameSize` (2048), `hopSize` (frameSize/4).


### `pitchShift`

Content-aware auto-selector. Picks: `voice`/`speech` → psola, `tonal` → sms, else → transient.

```js
import pitchShift from 'pitch-shift'

pitchShift(audio, { semitones: 5 })
pitchShift(audio, { ratio: 1.5, content: 'voice' })
pitchShift(audio, { ratio: 2, method: 'formant' })
```

| Param | Default | |
|---|---|---|
| `content` | `music` | `music`, `voice`/`speech`, `tonal` |
| `method` | auto | Force a specific algorithm by name |
| `formant` | `false` | Wrap in formant preservation |


## Frequency domain

### `transient`

Peak-locked phase vocoder with spectral-flux transient detection. On transient frames, synthesis phase resets to analysis phase, preserving attacks. Between transients, behaves like `phaseLock`.

```js
import transient from 'pitch-shift/transient.js'

transient(audio, { ratio: 1.5 })
transient(audio, { semitones: 5, transientThreshold: 2.0 })
```

| Param | Default | |
|---|---|---|
| `transientThreshold` | `1.5` | z-score over log-flux EMA (higher = fewer resets) |

**Preserves** phase coherence, partial structure, attack localization on detected transients.<br>
**Destroys** formants; misses quiet transients at too-high threshold.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.988 | 1.619 | 0.991 | 1.781 |

Formant dist 1.619 because bin-shift moves the spectral envelope with the partials — use `formant` to preserve it.

**Use when:** Music with drums — the default choice.<br>
**Not for:** Voice where formant preservation matters.


### `phaseLock`

Laroche-Dolson peak-locked phase vocoder. Peaks scatter to shifted bins; non-peak bins lock their phase relative to the nearest peak, keeping the vertical phase relationship inside each sinusoidal lobe intact.

```js
import phaseLock from 'pitch-shift/phase-lock.js'

phaseLock(audio, { ratio: 1.5 })
```

**Preserves** phase coherence around peaks, partial structure.<br>
**Destroys** transients (still smeared, less than `vocoder`), formants.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.988 | 1.623 | 0.991 | 1.775 |

Nearly identical to `transient` on non-percussive material. The 0.006 shift gap is the transient reset cost on synthetic fixtures that have no transients.

**Use when:** General music — the "try this first" phase vocoder.<br>
**Not for:** Music with drums (use `transient`), voice (use `formant`).


### `vocoder`

SMB/Bernsee bin-shift. Computes true instantaneous frequency per bin from consecutive-frame phase advance, scatters peaks to shifted bins, accumulates synthesis phase at the shifted frequency.

```js
import vocoder from 'pitch-shift/vocoder.js'

vocoder(audio, { ratio: 1.5 })
```

**Preserves** dominant-partial pitch, long-horizon phase per bin.<br>
**Destroys** transients, vertical phase coherence ("phasiness"), formants.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.983 | 1.343 | 0.922 | 1.491 |

Phase coh 0.922 from independent per-bin phase accumulation — no inter-bin locking. Lower shift score than `phaseLock` because the simpler scatter avoids peak-assignment artifacts on pure tones.

**Use when:** Simple tonal material, educational baseline.<br>
**Not for:** Music with percussion, voice.


### `formant`

Cepstral envelope preservation wrapping a peak-locked vocoder. Extracts spectral envelope via cepstral liftering from temporally-smoothed magnitude, flattens the spectrum, applies peak-locked pitch shift on the flat residual, re-imposes the original envelope.

```js
import formant from 'pitch-shift/formant.js'

formant(audio, { semitones: 5 })
formant(audio, { ratio: 0.75, envelopeWidth: 16 })
```

| Param | Default | |
|---|---|---|
| `envelopeWidth` | `max(8, N/64)` | Cepstrum lifter cutoff (quefrency bins) |

**Preserves** formant envelope (absolute Hz), vocal-tract character.<br>
**Destroys** transients (same as vocoder); risks cepstral ringing on sparse spectra.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.988 | **0.921** | 0.980 | 1.593 |

Best formant dist (0.921) by construction — the envelope is explicitly separated and re-applied. Slightly worse shift score than vocoder because the lifter→flatten→re-impose chain introduces spectral rounding.

**Use when:** Voice shifting without chipmunk / giant artifact.<br>
**Not for:** Percussion-heavy material (transients smear).


### `hpss`

Fitzgerald median-filter harmonic/percussive separation. Time-axis and frequency-axis medians produce soft Wiener masks splitting the spectrogram. Harmonic component is vocoder-shifted; percussive component passes through with original phase.

```js
import hpss from 'pitch-shift/hpss.js'

hpss(audio, { ratio: 1.5 })
hpss(audio, { ratio: 1.5, hpssTimeWidth: 31, hpssFreqWidth: 31 })
```

| Param | Default | |
|---|---|---|
| `hpssTimeWidth` | `17` | Median window width (frames) |
| `hpssFreqWidth` | `17` | Median window width (bins) |
| `hpssPower` | `2` | Soft-mask exponent |

**Preserves** percussive onset locations (unshifted) and harmonic pitch (shifted).<br>
**Destroys** signal quality at ambiguous mask boundaries (leakage in both directions).

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.052 | 0.996 | 1.267 | 0.922 | **1.464** |

Best overall shift score — keeping percussion unshifted sidesteps most artifacts. Alias 0.052 from residual harmonic energy leaking through the percussive mask.

**Use when:** Mixed music where drums should stay stationary while melody shifts.<br>
**Not for:** Solo tonal material (unnecessary separation overhead).


### `sms`

Spectral Modeling Synthesis. Parabolic-interpolated peak picking builds sinusoidal tracks `(freq, mag, phase)`; each peak's lobe is copied intact to `round(f·ratio)`. Stochastic residual shifts to ratio-scaled bins with analysis phase.

```js
import sms from 'pitch-shift/sms.js'

sms(audio, { ratio: 2 })
sms(audio, { ratio: 1.5, maxTracks: 40 })
```

| Param | Default | |
|---|---|---|
| `maxTracks` | `Infinity` | Max simultaneous sinusoidal tracks |
| `minMag` | `1e-4` | Peak detection threshold (linear) |

**Preserves** formant envelope (lobes scale freely with peaks), harmonic structure, tonal clarity.<br>
**Destroys** transients, noise-like textures (absorbed into residual), polyphony beyond `maxTracks`.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.002 | 0.953 | 2.028 | 0.922 | 1.761 |

Lower attack corr (0.953) because sinusoidal modeling smooths onset transients into the residual. Formant dist 2.028 despite natural lobe scaling — the residual component carries unshifted energy.

**Use when:** Sustained tonal / harmonic instruments, vowels.<br>
**Not for:** Percussion, noise-heavy material.


### `paulstretch`

Large-frame (16k) phase randomization. Magnitudes pulled from source bins at `k/ratio`; phases drawn uniformly from `[0, 2π)` every frame. Destroys temporal structure by design.

```js
import paulstretch from 'pitch-shift/paulstretch.js'

paulstretch(audio, { ratio: 1.5 })
```

**Preserves** long-term magnitude-spectrum statistics.<br>
**Destroys** phase, transients, rhythm — by design.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.3 | 0.232 | 0.954 | 7.113 | — | 2.339 |

Worst shift score (2.339) and formant dist (7.113) because random phases smear spectral energy across the frame — the smear is the aesthetic. Stream-vs-batch decorrelates (—) because random phase is non-deterministic.

**Use when:** Ambient/drone textures, extreme shift ratios.<br>
**Not for:** Anything requiring temporal precision.


## Time domain

### `wsola`

WSOLA time-stretch + sinc resample. Searches each grain position ±`tolerance` samples for maximum cross-correlation with the previous grain's tail, eliminating phase cancellation before resampling to the target pitch.

```js
import wsola from 'pitch-shift/wsola.js'

wsola(audio, { ratio: 0.85 })
wsola(audio, { ratio: 1.5, tolerance: 512 })
```

| Param | Default | |
|---|---|---|
| `tolerance` | `frameSize/4` | Similarity search radius (±samples) |

**Preserves** local waveform shape, attack envelopes.<br>
**Destroys** formants (shifted by resample), phase coherence across long spans.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 1.00 | 0.2 | 0.005 | **0.995** | 2.345 | 0.866 | 1.672 |

f0 err 1.00 Hz from sinc resample quantization (time-domain algorithms round the stretch ratio to grain boundaries). Best attack corr (0.995) — the similarity search preserves waveform continuity.

**Use when:** Speech, low-latency, anywhere the phase vocoder's frame latency is unacceptable.<br>
**Not for:** Polyphonic music with sustained tones.


### `psola`

PSOLA time-stretch + sinc resample. Autocorrelation detects pitch periods; two-period Hann grains are placed at pitch-synchronous intervals, preserving formants in the stretch stage.

```js
import psola from 'pitch-shift/psola.js'

psola(audio, { ratio: 0.75, sampleRate: 48000 })
psola(audio, { ratio: 1.5, minFreq: 100, maxFreq: 400 })
```

| Param | Default | |
|---|---|---|
| `sampleRate` | `44100` | For pitch detection range |
| `minFreq` | `70` | Lowest expected pitch (Hz) |
| `maxFreq` | `600` | Highest expected pitch (Hz) |

**Preserves** waveform-per-period shape, formants, voiced-speech naturalness.<br>
**Destroys** polyphony (assumes single pitch contour), unvoiced regions (pitch-mark jitter).

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.66 | 0.2 | 0.005 | 0.941 | 2.340 | **0.998** | 1.767 |

Best phase coherence (0.998) — pitch-synchronous grains align perfectly with the waveform period. Lower attack corr (0.941) from pitch-mark jitter on non-periodic onsets.

**Use when:** Monophonic speech, solo voice, single melodic instrument.<br>
**Not for:** Polyphonic material, chords.


### `ola`

Plain OLA time-stretch + sinc resample. Overlap-add without similarity search — the baseline the others improve on.

```js
import ola from 'pitch-shift/ola.js'

ola(audio, { ratio: 1.5 })
```

**Preserves** amplitude envelope.<br>
**Destroys** pitch accuracy, formants, transients, phase coherence.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 39.59 | 0.1 | 0.005 | 0.977 | 2.360 | 0.992 | 2.050 |

f0 err 39.59 Hz — worst by far. Without similarity search, grains land at arbitrary phase offsets causing destructive interference that shifts the perceived pitch. Onset err 0.388 for the same reason.

**Use when:** Reference baseline, or the simplest possible shift for comparison.<br>
**Not for:** Anything quality-sensitive.


### `granular`

Small-grain (1024) WSOLA time-stretch + sinc resample. Grain-rate artifacts are intentionally prominent — the texture is the point.

```js
import granular from 'pitch-shift/granular.js'

granular(audio, { ratio: 1.3 })
```

**Preserves** grain-local timbre, characteristic textural quality.<br>
**Destroys** pitch accuracy on complex tones, smooth envelopes.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.95 | 0.2 | 0.005 | 0.995 | 2.796 | 0.945 | 1.905 |

Worst formant dist among time-domain algorithms (2.796) because the small grains create audible spectral ripples.

**Use when:** Creative/textural effects where grain character is desired.<br>
**Not for:** Transparent pitch shifting.


### `sample`

Playback-rate pitch shift. Hann-windowed sinc interpolation at a fractional read-head stepped by `ratio` per output sample. No time preservation — higher pitch = shorter clip.

```js
import sample from 'pitch-shift/sample.js'

sample(instrumentBuffer, { semitones: 7 })
sample(audio, { ratio: 2, sincRadius: 16 })
```

| Param | Default | |
|---|---|---|
| `sincRadius` | `8` | Windowed-sinc half-width (samples) |

**Preserves** waveform identity (literally the same audio, faster/slower), formants — everything scales together.<br>
**Destroys** time: output duration = `input_length / ratio`, zero-padded to match API.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 2.50 | 0.1 | 0.007 | 0.951 | 2.245 | 0.170 | 1.655 |

Phase coh 0.170 because the modulation rate itself shifts with the pitch (a 5 Hz tremolo becomes 7.5 Hz at ratio 1.5). This is correct behavior for a sampler — not an artifact.

**Use when:** Instrument one-shots, ROM-sample playback, tracker-style.<br>
**Not for:** Time-preserving pitch shift.


### `hybrid`

Runs `phaseLock` and `wsola` in parallel, crossfades sample-by-sample by spectral-flux transient confidence. Tonal regions resolve via the phase vocoder; attacks resolve via WSOLA similarity search.

```js
import hybrid from 'pitch-shift/hybrid.js'

hybrid(audio, { ratio: 1.5 })
hybrid(audio, { ratio: 1.5, hybridThreshold: 0.6 })
```

| Param | Default | |
|---|---|---|
| `hybridThreshold` | `0.8` | Spectral-flux z-score for full WSOLA blend |

**Preserves** tonal phase coherence + attack shape — simultaneously.<br>
**Destroys** CPU budget (≈2×), formants.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.988 | 2.538 | 0.879 | 1.925 |

Phase coh 0.879 from crossfade blending — the detector's confidence curve creates micro-transitions between two engines with different phase trajectories. Worst on synthetic fixtures that have no transients to trigger the WSOLA path.

**Use when:** Mixed dynamic material where a single domain compromises the other.<br>
**Not for:** Pure tonal (just use `phaseLock`) or pure percussive (just use `transient`).


<details><summary>Full quality table</summary>

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
| `pitchShift` | 0.00 | 0.0 | 0.000 | 1.000 | 0.012 | 0.000 | 0.988 | 1.619 | 0.991 | 1.781 |
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
</details>


## Variable pitch

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
