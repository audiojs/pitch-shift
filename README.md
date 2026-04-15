# pitch-shift

Canonical pitch-shifting algorithms in functional JavaScript. Each algorithm is a first-class native implementation — no shared time-stretch+resample pipeline, no wrappers. Consistent unified API: batch, stream, multi-channel. Part of the audiojs ecosystem.

## Install

```bash
npm install pitch-shift
```

## Usage

```js
import pitchShift, { phaseLock, transient, psola, formant, wsola } from 'pitch-shift'

// Auto-select an algorithm from content hints
let auto = pitchShift(audio, { semitones: 5, content: 'voice' })

// Batch processing
let pitched = phaseLock(audio, { ratio: 1.5 })  // pitch up by factor of 1.5

// Streaming (real-time)
let write = phaseLock({ ratio: 1.5 })
let output = write(inputBlock)
let tail = write()  // flush

// Separate-channel stereo
let stereo = phaseLock([left, right], { ratio: 1.5 })
```

## Algorithms

Each algorithm is a canonical native pitch-shift implementation with its own character, not a wrapper over a shared pipeline.

| Algorithm | Domain | Form | Best for |
|-----------|--------|------|----------|
| `ola` | Time | Hann-windowed OLA with stride-`ratio` source read. Trivial, no similarity search, no pitch sync. | Baseline reference |
| `vocoder` | STFT | Bin-shift phase vocoder (SMB/Bernsee). True instantaneous frequency per bin, loudest-wins scatter, synthesis phase accumulation. | Simple tonal material |
| `phaseLock` | STFT | Laroche-Dolson peak-locked vocoder. Peaks get independent frequency shift; non-peak bins preserve phase offset relative to the nearest peak. | General music |
| `transient` | STFT | Peak-locked vocoder with spectral-flux transient detection. On transient frames, synthesis phase resets to analysis phase, preserving attacks. | Music with percussion |
| `psola` | Time | Native Pitch-Synchronous Overlap-Add. Autocorrelation period contour → pitch-mark detection → two-period Hann grains copied verbatim at spacing `period/ratio`. Formants preserved by construction. | Speech, monophonic voice |
| `wsola` | Time | Granular shift + per-grain similarity search (±`tolerance` samples) against the previous grain's tail in source-stride coordinates. | Speech, low-latency |
| `granular` | Time | Fixed-size Hann grains, stride-`ratio` source read, constant output hop. No similarity search. | Creative textures |
| `formant` | STFT | Cepstral envelope preservation. Flatten spectrum by the real-cepstrum envelope, vocoder-shift the flat residual, re-impose the envelope. | Voice (preserves formants) |
| `paulstretch` | STFT | Large-frame phase randomization. Magnitudes gathered from `k/ratio`; phases drawn uniformly from `[0, 2π)`. | Ambient, extreme shifts |
| `sms` | Sinusoidal | Peak-scaled Spectral Modeling Synthesis. Parabolic-interpolated peak picking → sinusoidal lobes shifted to `round(f·ratio)`, stochastic residual preserved. | Harmonic/tonal |
| `hpss` | STFT | Fitzgerald median-filter harmonic/percussive separation. Time-axis median → harmonic estimate; freq-axis median → percussive estimate; soft mask; vocoder-shift the harmonic part, pass-through the percussive. | Mixed music (drums+tonal) |
| `sample` | Time | Playback-rate pitch shift. Hann-windowed sinc interpolation at fractional read-head stepped by `ratio` per output sample. No time preservation — higher pitch = shorter clip (zero-padded tail). | Sampler/tracker instrument playback |
| `hybrid` | Hybrid | Crossfade between `phaseLock` (frequency domain) and `wsola` (time domain), weighted by per-sample spectral-flux transient confidence. Tonal regions resolve via the phase vocoder; attacks resolve via WSOLA similarity search. | Mixed dynamic material |

### Choosing an algorithm

Each algorithm preserves a different invariant and surrenders the rest. No single one wins everywhere — the reason to reach for one over another is what it keeps intact *by construction* and what it must give up for that. The guide below is what each canonical form trades.

**`ola`** — Overlap-add with a stride-`ratio` source read. The simplest thing that can be called pitch shifting. *Preserves* the amplitude envelope. *Destroys* pitch precision (grain-rate beating), phase, transients. *Reach for* understanding the others — use as a baseline, not a product.

**`vocoder`** — SMB/Bernsee bin-shift. Recovers the true instantaneous frequency of each bin from the consecutive-frame phase advance, then re-accumulates synthesis phase at the shifted frequency. *Preserves* dominant-partial pitch and long-horizon phase for each bin independently. *Destroys* transients (smeared across the frame), vertical phase coherence between adjacent bins ("phasiness"), formants. *Reach for* simple tonal material and minimal correct spectral pitch shift.

**`phaseLock`** — Laroche-Dolson peak-locked vocoder. Locks non-peak bins' synthesis phase to the nearest peak's, keeping the vertical phase relationship inside each sinusoidal lobe intact. *Preserves* phase coherence around each peak, partial structure, pitch accuracy. *Destroys* transients (still smeared, less than `vocoder`), formants. *Reach for* general music — the "try this first" phase vocoder.

**`transient`** — `phaseLock` plus spectral-flux transient detection. On flagged frames the synthesis phase snaps back to the analysis phase so the attack shape re-emerges verbatim. *Preserves* everything `phaseLock` preserves, plus attack localization on detected transients. *Destroys* formants; misses quiet transients at a too-high threshold and smears them. *Reach for* music with percussion where `phaseLock` alone loses the attack.

**`psola`** — Native Pitch-Synchronous Overlap-Add. Autocorrelation period contour → pitch-mark picking → two-period Hann grains copied verbatim and OLA'd at spacing `period/ratio`. *Preserves* waveform-per-period shape and therefore formants by construction (leading `formant dist`), attack localization, voiced-speech naturalness. *Destroys* polyphony (assumes a single pitch contour), unvoiced regions (pitch-mark jitter), and — canonically — pure sinusoids: with no formant filter to re-excite, the OLA of identical sine-shaped grains produces interference at the original fundamental rather than a shifted tone. *Reach for* monophonic speech, solo voice, or a single melodic instrument with formant structure.

**`wsola`** — Granular shift with per-grain similarity search. Each new grain lands at the position inside a ±`tolerance` window that maximally correlates with the previous grain's tail. *Preserves* local waveform shape, attack envelopes, strict causality (small look-ahead only). *Destroys* pitch precision on pure tones (the search jitters grain boundaries), phase coherence across long spans, harmonic purity. *Reach for* low-latency speech, or anywhere the phase vocoder's frame is unacceptable.

**`granular`** — Fixed-size Hann grains, constant output hop, stride-`ratio` read inside each grain. No similarity search, no pitch sync. *Preserves* grain-local timbre and a characteristic textural quality. *Destroys* pitch accuracy, phase, smooth envelopes (the grain rate becomes audible). *Reach for* creative/textural effects where the grain character is the point.

**`formant`** — Cepstral envelope preservation wrapping a vocoder shift. Lifter-flatten the spectrum by its real-cepstrum envelope, shift the flat residual in bin space, re-impose the envelope unchanged. *Preserves* formant envelope (absolute Hz), vocal-tract character. *Destroys* what `vocoder` destroys (transients smear), risks cepstral ringing on very noisy or very sparse spectra. *Reach for* voice shifting without the chipmunk/giant artifact.

**`paulstretch`** — Large-frame phase randomization. Magnitudes are gathered from source bins at `k/ratio`; phases are redrawn uniformly from `[0, 2π)` every frame. *Preserves* long-term magnitude-spectrum statistics. *Destroys* phase, transients, any rhythmic micro-structure — by design. Stream-vs-batch decorrelates inherently, which is why the metric is marked `—`. *Reach for* ambient/drone textures and extreme shift ratios where the smear is the aesthetic.

**`sms`** — Peak-scaled Spectral Modeling Synthesis. Parabolic-interpolated peak picking builds a small track list of `(freq, mag, phase)` triples; each peak's lobe is copied intact to `round(f·ratio)`; the stochastic residual is left unshifted. *Preserves* formant envelope (lobes scale freely with their peaks), harmonic structure, tonal clarity. *Destroys* transients, noise-like textures (absorbed into the residual), polyphonic material beyond `maxTracks`. *Reach for* sustained tonal/harmonic instruments and vowels where envelope matters.

**`hpss`** — Fitzgerald 2010 median-filter harmonic/percussive separation. Time-axis median → harmonic-friendly view; freq-axis median → percussive-friendly view; soft Wiener mask at exponent `p` splits the spectrogram. The harmonic component is vocoder-shifted; the percussive component passes through at its original phase. *Preserves* percussive onset locations (unshifted) and harmonic pitch (shifted). *Destroys* a little signal quality to mask leakage in both directions on ambiguous material. *Reach for* mixed music where drums and tonal content coexist and the kit should stay stationary while the melody moves.

**`sample`** — Playback-rate pitch shift: Hann-windowed sinc interpolation at a fractional read-head stepped by `ratio` per output sample. The intuition hardware samplers and tracker modules run on. *Preserves* waveform identity (literally the same audio, faster or slower) and formants trivially — everything scales together. *Destroys* time: output duration is `input_length / ratio`, and the tail is zero-padded to keep the unified API. *Reach for* instrument one-shots, ROM-sample playback, any context where "higher pitch = shorter clip" is the intended effect.

**`hybrid`** — Runs `phaseLock` and `wsola` in parallel and crossfades sample-by-sample by a transient-confidence signal from spectral flux. Tonal regions resolve via the phase vocoder; attacks resolve via WSOLA similarity search. *Preserves* phase coherence on tonal regions and attack shape on transients — simultaneously. *Destroys* CPU budget (≈2×), strict low-latency causality (the detector looks both ways), formants. *Reach for* mixed dynamic material where a single domain compromises the other.

### Measured quality

Each algorithm is measured across ten canonical properties on synthetic fixtures with exact ground truth. The **shift** column is a direct log-magnitude distance between the algorithm output and a canonically generated shifted reference (e.g. `sine(660)` as the ground truth for `pitchShift(sine(440), 1.5)`) — no heuristic, no proxy metric. Run `npm run quality` for the live numbers.

| Algorithm | f0 err | THD% | alias | stream corr | cent err | onset err | attack corr | formant dist | phase coh | shift |
|-----------|-------:|-----:|------:|------------:|---------:|----------:|------------:|-------------:|----------:|------:|
| `pitchShift` (auto) | 0.00 | 0.0 | 0.000 | 1.000 | 0.012 | 0.000 | 0.985 | 1.600 | 0.993 | 1.795 |
| `phaseLock` | 0.00 | 0.0 | 0.000 | 1.000 | 0.012 | 0.000 | 0.986 | 1.591 | 0.993 | 1.796 |
| `transient` | 0.00 | 0.0 | 0.000 | 1.000 | 0.012 | 0.000 | 0.985 | 1.600 | 0.993 | 1.795 |
| `vocoder` | 0.00 | 0.0 | 0.000 | 1.000 | 0.006 | 0.000 | 0.983 | 1.343 | 0.922 | **1.491** |
| `hpss` | 0.00 | 0.0 | 0.052 | 1.000 | 0.012 | 0.000 | 0.983 | 1.234 | 0.922 | 1.492 |
| `formant` | 0.00 | 0.0 | 0.000 | 1.000 | 0.061 | 0.000 | 0.984 | **0.955** | 0.978 | 1.605 |
| `sms` | 0.00 | 0.0 | 0.002 | 1.000 | 0.001 | 0.000 | 0.953 | 2.028 | 0.922 | 1.761 |
| `sample` | 1.00 | 0.2 | 0.006 | 1.000 | 0.002 | 0.000 | 0.995 | 2.366 | 0.869 | 1.671 |
| `paulstretch` | 0.00 | 0.6 | 0.258 | — | 0.001 | 0.000 | 0.941 | 7.273 | 0.778 | 2.314 |
| `hybrid` | 0.00 | 0.0 | 0.000 | 1.000 | 0.001 | 0.000 | 0.986 | 2.981 | 0.710 | 1.871 |
| `psola` | 0.66 | 0.2 | 0.005 | 1.000 | 0.003 | 0.000 | 0.941 | 2.340 | **0.998** | 1.768 |
| `wsola` | 1.00 | 0.2 | 0.005 | 1.000 | 0.003 | 0.000 | 0.995 | 2.372 | 0.869 | 1.665 |
| `granular` | 1.09 | 0.1 | 0.005 | 1.000 | 0.008 | 0.000 | 0.995 | 3.438 | 0.978 | 1.891 |
| `ola` | 0.29 | 0.1 | 0.005 | 1.000 | 0.042 | 0.000 | 0.992 | 2.498 | 0.971 | 1.780 |

Columns:

- **f0 err** (Hz) — pitch accuracy shifting a 440 Hz sine to 660 Hz. Zero-crossing estimator over the active signal region.
- **THD%** — total harmonic distortion on the shifted pure sine (up to 8 harmonics).
- **alias** — active-region RMS of output / input when shifting a 14 kHz sine by ×2. Canonical behaviour is near zero (nothing valid above Nyquist); time-domain stride-reads fold energy back.
- **stream corr** — streaming vs batch correlation on the 440 Hz sine. Marked — for algorithms whose phase or grain jitter decorrelates on pure tones even when producing valid output (paulstretch randomizes phases, psola jitters pitch marks).
- **cent err** — spectral centroid ratio error on a 3-partial chord. Lower means the timbre shifts by exactly `ratio`.
- **onset err** — period error of a 100 Hz Dirac impulse train after shift. Measures how well impulse locations survive.
- **attack corr** — plucked-string attack envelope correlation against the input.
- **formant dist** — cepstral envelope distance on a synthetic vowel. Lower = formants stay put. `psola`, `formant`, and `sms` dominate here.
- **phase coh** — AM-envelope coherence on a 5 Hz tremolo. Goertzel-extracted modulation depth, `min(out, in) / max(out, in)`. 1.0 means the slow envelope survives the shift intact. Marked — for `paulstretch` (random phase is non-deterministic), `psola` (TD-PSOLA has no frame-level phase model), and `sample` (time-compresses, so the modulation rate itself shifts).
- **shift** (log-mag) — direct log-magnitude spectral distance between the algorithm output and the canonical shifted reference, averaged over four harmonic ground-truth fixtures: `sine(660)`, `sineChord(330, [1,1.25,1.5])`, `karplusStrong(330)`, and `amSine(660)`. Gain- and phase-invariant. Bold = leader. The single best "how close to the ideal pitch shift" number.

Notes. `formant`, `hpss`, and `sms` dominate formant preservation by construction. `transient` dominates transient preservation on drum material even though `attack corr` on a plucked string is close across algorithms. `paulstretch` stream-vs-batch is marked — because random phase synthesis decorrelates by design. See `scripts/fixtures.js` and `scripts/metrics.js` for the full rig.

### Options

All algorithms accept:

| Option | Default | Description |
|--------|---------|-------------|
| `ratio` | `1` | Pitch shift ratio (1.5 = +5 semitones, 2 = +1 octave) |
| `semitones` | from ratio | Pitch shift in semitones |
| `content` | `music` | Auto-select hint for the default export: `music`, `voice`, `speech`, `tonal` |
| `method` | auto | Explicit algorithm for the default export |
| `formant` | `false` | Use formant-preserving shifting through the default export |
| `frameSize` | `2048` | Frame size in samples |
| `hopSize` | `frameSize/4` | Hop between frames |

Algorithm-specific options:

- **`transient`**: `transientThreshold` (default: `1.5`) — z-score over log-flux EMA
- **`psola`**: `sampleRate`, `minFreq` (default `70`), `maxFreq` (default `600`)
- **`wsola`**: `tolerance` (default `max(4, hop/2)`) — similarity search radius
- **`formant`**: `envelopeWidth` (default `max(8, N/64)`) — cepstrum lifter cutoff
- **`sms`**: `maxTracks` (default `80`), `minMag` (default `1e-4`)
- **`hpss`**: `hpssTimeWidth` (default `17` frames), `hpssFreqWidth` (default `17` bins), `hpssPower` (default `2`) — median window sizes and soft-mask exponent
- **`sample`**: `sincRadius` (default `8`) — windowed-sinc half-width in samples
- **`hybrid`**: `hybridThreshold` (default `0.8`) — spectral-flux z-score threshold for full WSOLA blend

Default export selection:

- `voice` / `speech` → `psola`
- `tonal` → `sms`
- everything else → `transient`

### Variable pitch (pitch curves)

`phaseLock` and `sample` accept a time-varying `ratio` — either a function `(timeSeconds) => ratio` or a `Float32Array` sampled uniformly across the input duration.

```js
// Sinusoidal vibrato: ±10% pitch at 5 Hz
let vibrato = phaseLock(audio, {
  ratio: (t) => 1 + 0.1 * Math.sin(2 * Math.PI * 5 * t),
  sampleRate: 44100,
})

// Glissando from unison to +1 octave across a 2-second clip
let glide = sample(audio, {
  ratio: new Float32Array([1, 1.25, 1.5, 1.75, 2]),
  ratioDuration: 2,
  sampleRate: 44100,
})
```

Other algorithms reject function/array `ratio` with a clear error — their canonical forms assume a single global ratio.

### Examples

```js
import { phaseLock, transient, psola, formant, granular, wsola, sms, hpss, sample, hybrid } from 'pitch-shift'

// Music with drums
let result = transient(audio, { ratio: 1.5 })

// Mixed music (drums + tonal content) with harmonic/percussive separation
let mixed = hpss(audio, { ratio: 1.5 })

// Hybrid: transient-gated crossfade between phase vocoder and WSOLA
let dynamic = hybrid(audio, { ratio: 1.5 })

// Voice (formant-preserving)
let voice = formant(audio, { semitones: 5 })

// Speech
let speech = psola(audio, { ratio: 0.75, sampleRate: 48000 })

// Tonal/harmonic
let tonal = sms(audio, { ratio: 2 })

// Creative granular
let grainy = granular(audio, { ratio: 1.3 })

// Explicit WSOLA alias
let speech = wsola(audio, { ratio: 0.85 })

// Sampler-style playback rate (instrument one-shots)
let played = sample(instrumentBuffer, { semitones: 7 })
```

## Streaming

All algorithms support block-by-block streaming:

```js
let write = phaseLock({ ratio: 1.5 })

// Process audio in chunks
let chunk1 = write(inputBlock1)   // → Float32Array
let chunk2 = write(inputBlock2)
let tail = write()                // flush remaining
```

## Stereo/Multi-channel

Process channels independently:

```js
let leftOut = phaseLock(leftChannel, { ratio: 1.5 })
let rightOut = phaseLock(rightChannel, { ratio: 1.5 })

// Or pass separate channels together
let [leftShifted, rightShifted] = phaseLock([leftChannel, rightChannel], { ratio: 1.5 })
```

## Quality Tools

```bash
npm test
npm run quality
npm run bench
```

`npm run quality` reports pitch accuracy, stream-vs-batch correlation, stereo handling, and high-frequency attenuation.

## Dependencies

- [fourier-transform](https://github.com/audiojs/fourier-transform) — FFT
- [window-function](https://github.com/audiojs/window-function) — Hann windowing

## Migration from `pitch-shift` v0.0.0

The package name was previously held by [mikolalysenko/pitch-shift](https://github.com/mikolalysenko/pitch-shift) (2013, frozen at v0.0.0). That package implements a single time-domain algorithm: per-frame Hann windowing → `detect-pitch` autocorrelation period → `scalePitch` linear interpolation → `findMatch` splice-point similarity search → overlap-add. This is the canonical WSOLA/TD-PSOLA pattern.

The same algorithm is available here as [`wsola`](#algorithms) (with per-grain cross-correlation search) or [`psola`](#algorithms) (with autocorrelation pitch marks). Both are native implementations without external pitch-detection dependencies and support batch, streaming, and multi-channel.

The old callback API:

```js
// v0.0.0 (old)
var shifter = require('pitch-shift')(onData, t => ratio, { frameSize: 2048 })
shifter.feed(float32Array)
```

New equivalent:

```js
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
