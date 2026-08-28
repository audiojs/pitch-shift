# @audio/shift [![test](https://github.com/audiojs/shift/actions/workflows/test.yml/badge.svg)](https://github.com/audiojs/shift/actions/workflows/test.yml) [![npm](https://img.shields.io/npm/v/@audio/shift?color=white)](https://www.npmjs.com/package/@audio/shift) [![demo](https://img.shields.io/badge/demo-live-black)](https://audiojs.github.io/pitch-shift/demo)

Try it in the browser: [Pitch and tempo changer](https://audiojs.dev/util/pitch-tempo/). Runs on this package, nothing is uploaded.

Canonical pitch-shifting algorithms in functional JavaScript.<br>
_Frequency-domain_: vocoder, phaseLock, transient, formant, sms, hpss.<br>
_Time-domain_: ola, wsola, psola, granular, sample, delay.<br>
_Source-filter_: lpc.<br>
Consistent unified API: batch, stream, multi-channel — 15 algorithms.
Part of the audiojs ecosystem.

## Install

```bash
npm install @audio/shift
```

Each algorithm also ships standalone — `npm install @audio/shift-transient`, `@audio/shift-lpc`, etc. — for installs that need only one.

## Usage

```js
import { transient } from '@audio/shift'

// Batch
let pitched = transient(audio, { semitones: 5 })

// Stream
let write = transient({ ratio: 1.5 })
let output = write(inputBlock)
let tail = write()  // flush

// Stereo
let [L, R] = transient([left, right], { ratio: 1.5 })
```

`write`/`flush` is the same shape everywhere, but not every algorithm streams incrementally. `vocoder`, `phaseLock`, `transient`, `formant`, and `sms` emit audio frame-by-frame as it arrives. Every other algorithm — `ola`, `psola`, `wsola`, `granular`, `paulstretch`, `hpss`, `sample`, `hybrid`, `delay`, `lpc` — buffers the whole input and returns everything on the matching flush call; the API is uniform, the latency isn't.

## Algorithms

| | Domain | Best for | shift |
|---|---|---|---|
| [pitchShift](#pitchshift) | auto | content-aware default | 1.755 |
| [transient](#transient) | STFT | music with percussion ★ | 1.755 |
| [phaseLock](#phaselock) | STFT | general music | 1.755 |
| [vocoder](#vocoder) | STFT | simple tonal | 1.553 |
| [formant](#formant) | STFT | voice (no chipmunk) | 1.573 |
| [hpss](#hpss) | STFT | mixed music (drums+tonal) | **1.487** |
| [sms](#sms) | sinusoidal | harmonic/tonal | 1.701 |
| [paulstretch](#paulstretch) | STFT | ambient, extreme shifts | 2.221 |
| [wsola](#wsola) | time | speech, low-latency | 1.674 |
| [psola](#psola) | time | speech, mono voice | 1.766 |
| [delay](#delay) | delay-line | real-time, harmonizer | 1.610 |
| [ola](#ola) | time | baseline | 2.025 |
| [granular](#granular) | time | creative textures | 2.256 |
| [sample](#sample) | time | sampler/tracker playback | 1.614 |
| [hybrid](#hybrid) | hybrid | mixed dynamic material | 1.824 |
| [lpc](#lpc) | source-filter | speech, formant filter | 1.811 |

Frequency-domain algorithms shift bins natively. `ola`/`wsola`/`psola` stretch time via [stretch](https://github.com/audiojs/stretch), then sinc-resample back to pitch. `granular`, `sample`, `delay`, and `lpc` shift natively — no stretch-then-resample stage. **shift** = log-magnitude distance to canonical reference (lower is better). Run `npm run quality` for all metrics.

All algorithms accept `ratio` (1.5 = +7 semitones, 2 = octave) and `semitones`. `frameSize` (2048) / `hopSize` (frameSize/4) apply to the STFT family, `ola`, `wsola`, and `hybrid`; `granular` (`grainSize`), `delay` (`window`/`tolerance`), `lpc` (`frameSize` alone, no `hopSize`), and `sample`/`psola` (no frame parameter) each use their own — see each section.

## Runtime behavior

Every algorithm's streaming output is numerically identical to its batch output on the same input, byte for byte. For `ola`, `psola`, `wsola`, `granular`, `paulstretch`, `hpss`, `sample`, `hybrid`, `delay`, and `lpc`, that's automatic — the stream writer buffers the whole input and runs the batch code path once at `flush()`. For `vocoder`, `phaseLock`, `transient`, `formant`, and `sms`, it's a real per-frame guarantee: each frame renormalizes its own energy independently of every other frame, so a batch run and a run fed one differently-chunked block at a time land on the exact same output.

That per-frame renormalization also replaces whole-signal loudness correction for those five: none of them apply a post-hoc RMS match (`matchGain`) anymore, and loudness still lands within **~1 dB** of the input (measured −0.98 to +0.10 dB across the family on a plain sine). `lpc` is the exception — its excitation-domain repitching can drift level with the AR envelope's own gain, so it still applies one whole-signal `matchGain` pass at the end.


### `pitchShift`

Content-aware auto-selector. Picks: `voice`/`speech` → psola, `tonal` → sms, else → transient.

```js
import pitchShift from '@audio/shift'

pitchShift(audio, { semitones: 5 })
pitchShift(audio, { ratio: 1.5, content: 'voice' })
pitchShift(audio, { ratio: 2, method: 'formant' })
pitchShift(audio, { ratio: 1.5, method: 'delay' })
```

| Param | Default | |
|---|---|---|
| `content` | `music` | `music`, `voice`/`speech`, `tonal` |
| `method` | auto | Force any algorithm by name, including `'delay'`/`'lpc'` |
| `formant` | `false` | Wrap in formant preservation |

`formant: true` together with an explicit, different `method` throws instead of silently overriding it — pass just one.


## Frequency domain

### `transient`

Peak-locked phase vocoder with spectral-flux transient detection. On transient frames, synthesis phase resets to analysis phase, preserving attacks. Between transients, behaves like `phaseLock`.

```js
import { transient } from '@audio/shift'

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
| 0.00 | 0.0 | 0.000 | 0.984 | 1.423 | 0.999 | 1.755 |

Byte-identical to `phaseLock` on every fixture in the quality suite — the onset detector's z-score gate never fires on them, not even the plucked string's attack. It's built for real percussive onsets (see the demo's rock-beat fixture, which `npm run quality` doesn't score); on this synthetic suite it's a phaseLock with unused wiring.

**Use when:** Music with drums — the default choice.<br>
**Not for:** Voice where formant preservation matters.


### `phaseLock`

Laroche-Dolson peak-locked phase vocoder. Peaks scatter to shifted bins; non-peak bins lock their phase relative to the nearest peak, keeping the vertical phase relationship inside each sinusoidal lobe intact.

```js
import { phaseLock } from '@audio/shift'

phaseLock(audio, { ratio: 1.5 })
```

**Preserves** phase coherence around peaks, partial structure.<br>
**Destroys** transients (still smeared, less than `vocoder`), formants.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.984 | 1.423 | 0.999 | 1.755 |

**Use when:** General music — the "try this first" phase vocoder.<br>
**Not for:** Music with drums (use `transient`), voice (use `formant`).


### `vocoder`

SMB/Bernsee bin-shift. Computes true instantaneous frequency per bin from consecutive-frame phase advance, scatters peaks to shifted bins, accumulates synthesis phase at the shifted frequency.

```js
import { vocoder } from '@audio/shift'

vocoder(audio, { ratio: 1.5 })
```

**Preserves** dominant-partial pitch, long-horizon phase per bin.<br>
**Destroys** transients, vertical phase coherence ("phasiness"), formants.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.981 | 1.158 | 0.928 | 1.553 |

Phase coh 0.928 from independent per-bin phase accumulation — no inter-bin locking. Best shift score among the general phase vocoders — the simpler scatter avoids the peak-locked family's own assignment overhead on these fixtures.

**Use when:** Simple tonal material, educational baseline.<br>
**Not for:** Music with percussion, voice.


### `formant`

Cepstral envelope preservation wrapping a peak-locked vocoder. Extracts spectral envelope via cepstral liftering from temporally-smoothed magnitude, flattens the spectrum, applies peak-locked pitch shift on the flat residual, re-imposes the original envelope.

```js
import { formant } from '@audio/shift'

formant(audio, { semitones: 5 })
formant(audio, { ratio: 0.75, envelopeWidth: 16 })
```

| Param | Default | |
|---|---|---|
| `envelopeWidth` | `max(8, round(sr/1378))`, ≤ N/4 | Cepstrum lifter cutoff (quefrency bins) |

**Preserves** formant envelope (absolute Hz), vocal-tract character.<br>
**Destroys** transients (same as vocoder); risks cepstral ringing on sparse spectra.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.987 | **0.765** | **1.000** | 1.573 |

Best formant dist in the collection by construction — the envelope is explicitly separated and re-applied. Also the best phase coherence (1.000): the correction reshapes magnitude only, so it inherits the peak-locked vocoder's phase tracking untouched, and gains a hair over `phaseLock` itself.

**Use when:** Voice shifting without chipmunk / giant artifact.<br>
**Not for:** Percussion-heavy material (transients smear).


### `hpss`

Fitzgerald median-filter harmonic/percussive separation. Time-axis and frequency-axis medians produce soft Wiener masks splitting the spectrogram. Harmonic component is vocoder-shifted; percussive component passes through with original phase.

```js
import { hpss } from '@audio/shift'

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
| 0.00 | 0.0 | 0.052 | **0.998** | 1.207 | 0.928 | **1.487** |

Best overall shift score — keeping percussion unshifted sidesteps most artifacts. It also has the best attack correlation in the whole collection (0.998): the percussive component's phase is never touched, so a plucked-string attack survives more faithfully than even the time-domain similarity-search methods. Alias 0.052 is residual harmonic energy leaking through the percussive mask.

**Use when:** Mixed music where drums should stay stationary while melody shifts.<br>
**Not for:** Solo tonal material (unnecessary separation overhead).


### `sms`

Spectral Modeling Synthesis. Parabolic-interpolated peak picking builds sinusoidal tracks `(freq, mag, phase)`; each peak's lobe is copied intact to `round(f·ratio)`. Stochastic residual shifts to ratio-scaled bins with analysis phase.

```js
import { sms } from '@audio/shift'

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
| 0.00 | 0.0 | 0.002 | 0.963 | 1.845 | 0.929 | 1.701 |

Lower attack corr (0.963) because sinusoidal modeling smooths onset transients into the residual.

**Use when:** Sustained tonal / harmonic instruments, vowels.<br>
**Not for:** Percussion, noise-heavy material.


### `paulstretch`

Large-frame (16k) phase randomization. Magnitudes pulled from source bins at `k/ratio`; phases drawn from a seeded PRNG every frame. Destroys temporal structure by design.

```js
import { paulstretch } from '@audio/shift'

paulstretch(audio, { ratio: 1.5 })
paulstretch(audio, { ratio: 1.5, seed: 42 })
```

| Param | Default | |
|---|---|---|
| `seed` | fixed (`0x1f123bb5`) | 32-bit PRNG seed for the per-frame phase draw |

Deterministic: the same `seed` (the shipped default, or one you pass) always reproduces the same phase sequence and therefore byte-identical output. Pass `seed` to get a different, still-reproducible draw.

**Preserves** long-term magnitude-spectrum statistics.<br>
**Destroys** phase, transients, rhythm — by design.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.2 | 0.230 | 0.935 | 7.371 | 0.518 | 2.221 |

Worst formant dist by a wide margin (7.371 — the next-worst is `granular` at 3.486) because random phases smear spectral energy across the frame; the smear is the aesthetic. Alias 0.230 is the same smear leaking past Nyquist.

**Use when:** Ambient/drone textures, extreme shift ratios.<br>
**Not for:** Anything requiring temporal precision.


## Time domain

### `wsola`

WSOLA time-stretch + sinc resample. Searches each grain position ±`tolerance` samples for maximum cross-correlation with the previous grain's tail, eliminating phase cancellation before resampling to the target pitch.

```js
import { wsola } from '@audio/shift'

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
| 1.67 | 0.1 | 0.005 | 0.995 | 2.358 | 0.864 | 1.674 |

f0 err 1.67 Hz from sinc resample quantization (time-domain algorithms round the stretch ratio to grain boundaries). Attack corr 0.995 ties `delay` for second place — only `hpss`'s untouched percussive pass-through scores higher.

**Use when:** Speech, low-latency, anywhere the phase vocoder's frame latency is unacceptable.<br>
**Not for:** Polyphonic music with sustained tones.


### `psola`

PSOLA time-stretch + sinc resample. Autocorrelation detects pitch periods; two-period Hann grains are placed at pitch-synchronous intervals, reducing the grain-boundary artifacts plain WSOLA gets on voiced monophonic material. The final resample rescales the whole spectrum by `ratio`, so formants move with f0 exactly as they do for `wsola` — this is a smoother stretch, not formant preservation.

```js
import { psola } from '@audio/shift'

psola(audio, { ratio: 0.75, sampleRate: 48000 })
psola(audio, { ratio: 1.5, minFreq: 100, maxFreq: 400 })
```

| Param | Default | |
|---|---|---|
| `sampleRate` | `44100` | For pitch detection range |
| `minFreq` | `80` | Lowest expected pitch (Hz) |
| `maxFreq` | `500` | Highest expected pitch (Hz) |

**Preserves** waveform-per-period shape, voiced-speech naturalness.<br>
**Destroys** formants (same resample-driven shift as `wsola`), polyphony (assumes single pitch contour), unvoiced regions (pitch-mark jitter); falls back to plain WSOLA internally when no reliable pitch period is found.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.66 | 0.2 | 0.005 | 0.941 | 2.336 | 0.998 | 1.766 |

Phase coherence 0.998 — pitch-synchronous grains align with the waveform period almost perfectly, just short of `formant`'s 1.000. Lower attack corr (0.941) from pitch-mark jitter on non-periodic onsets.

**Use when:** Monophonic speech, solo voice, single melodic instrument.<br>
**Not for:** Polyphonic material, chords, or anywhere formants must stay put (use `lpc`).


### `delay`

Canonical delay-line (harmonizer) pitch shift — the method behind hardware harmonizers (Eventide H910 lineage, Lexicon "rotating tape head"). Two read taps sweep a modulated delay window at rate `ratio`, alternating through a Hann crossfade a half-cycle apart. Each time a tap wraps, it splices at whichever lag offset in the search window best correlates with the still-live tap ("intelligent splicing"), which is what keeps the join from phase-slipping the carrier.

```js
import { delay } from '@audio/shift'

delay(audio, { ratio: 1.5 })
delay(audio, { ratio: 1.5, window: 1024, tolerance: 128 })
```

| Param | Default | |
|---|---|---|
| `window` | `2048` | Delay-line length (samples); trades flutter rate against transient smear |
| `tolerance` | `window/4` | Splice search radius (±samples) |

**Preserves** duration, pitch accuracy — no grain or frame to quantize the shift against; state is bounded by `window` samples, the shape a real-time implementation needs.<br>
**Destroys** clean sustain on wideband or polyphonic material — the two taps share one delay line, so simultaneous partials all splice through the same wrap points and beat against each other; audible as mild flutter at the crossfade rate.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 1.10 | 0.1 | 0.028 | 0.995 | 2.445 | 0.940 | 1.610 |

f0 err 1.10 Hz sits at the measurement floor — nothing here to quantize pitch against. Formant dist 2.445 is unremarkable: the shared delay line resamples the envelope exactly like a time-domain stretch does, no better.

The streaming `write`/`flush` wrapper shipped here buffers the whole input like `hpss`/`hybrid` (see [Runtime behavior](#runtime-behavior)) — the algorithm's own state is bounded by `window` samples, but nothing yet exposes that as incremental output.

**Use when:** Real-time-shaped, lowest-latency time-domain shifting, or the hardware-harmonizer flutter is the wanted character.<br>
**Not for:** Dense chords or polyphony (the splice artifacts stack per partial).


### `ola`

Plain OLA time-stretch + sinc resample. Overlap-add without similarity search — the baseline the others improve on.

```js
import { ola } from '@audio/shift'

ola(audio, { ratio: 1.5 })
```

**Preserves** amplitude envelope.<br>
**Destroys** pitch accuracy, formants, transients, phase coherence.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 38.33 | 0.2 | 0.004 | 0.980 | 2.342 | 0.995 | 2.025 |

f0 err 38.33 Hz — worst by far. Without similarity search, grains land at arbitrary phase offsets causing destructive interference that shifts the perceived pitch.

**Use when:** Reference baseline, or the simplest possible shift for comparison.<br>
**Not for:** Anything quality-sensitive.


### `granular`

Native granular pitch shift: fixed-size Hann grains laid at a constant output hop, each read from the source through an anti-aliased sinc stride read (no separate stretch+resample stage). Small grains make the per-grain splice audible as a signature grain-rate texture — that texture is the point, not a defect.

```js
import { granular } from '@audio/shift'

granular(audio, { ratio: 1.3 })
granular(audio, { ratio: 1.3, grainSize: 1024 })
```

| Param | Default | |
|---|---|---|
| `grainSize` | `398` | Grain length in samples |

**Preserves** grain-local timbre, characteristic textural quality.<br>
**Destroys** pitch accuracy on complex tones, smooth envelopes — the 398-sample default is tuned so a chord's partials crumble audibly (~14% RMS loss) while a clean 440 Hz tone still tracks true; that crumble on chords is documented character, not a bug.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 1.45 | 0.0 | 0.033 | 0.996 | 3.486 | 0.997 | 2.256 |

Worst shift score and worst formant dist among all 15 algorithms — small, uncorrelated grains smear the spectrum more than even `paulstretch`'s random phase does. Raise `grainSize` toward 1024+ for a cleaner, less textural shift; the default favors character over transparency.

**Use when:** Creative/textural effects where grain character is desired.<br>
**Not for:** Transparent pitch shifting.


### `sample`

Playback-rate pitch shift. Hann-windowed sinc interpolation at a fractional read-head stepped by `ratio` per output sample. No time preservation — higher pitch = shorter clip.

```js
import { sample } from '@audio/shift'

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
| 2.50 | 0.1 | 0.007 | 0.951 | 2.330 | 0.170 | 1.614 |

Phase coh 0.170 because the modulation rate itself shifts with the pitch (a 5 Hz tremolo becomes 7.5 Hz at ratio 1.5). This is correct behavior for a sampler — not an artifact.

**Use when:** Instrument one-shots, ROM-sample playback, tracker-style.<br>
**Not for:** Time-preserving pitch shift.


### `hybrid`

Runs `phaseLock` and `wsola` in parallel, crossfades sample-by-sample by spectral-flux transient confidence. Tonal regions resolve via the phase vocoder; attacks resolve via WSOLA similarity search, time-aligned against phaseLock before blending so the two engines' attacks land together.

```js
import { hybrid } from '@audio/shift'

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
| 0.00 | 0.0 | 0.000 | 0.984 | 1.423 | 0.999 | 1.824 |

Same phaseLock-derived numbers as `phaseLock`/`transient` on this non-percussive suite — the WSOLA blend never activates because nothing here crosses `hybridThreshold`. Worst shift score among the frequency-adjacent methods for the same reason: it's carrying `wsola`'s parallel computation for a blend that stays at zero.

**Use when:** Mixed dynamic material where a single domain compromises the other.<br>
**Not for:** Pure tonal (just use `phaseLock`) or pure percussive (just use `transient`).


## Source-filter

### `lpc`

Canonical LPC source-filter pitch shift (residual-excited linear prediction, RELP lineage). Per frame: fit the vocal-tract all-pole filter A(z) by the autocorrelation method (Levinson-Durbin), inverse-filter the signal down to its spectrally-flat excitation residual, repitch that residual with the `delay` line splicer, then resynthesize through the **unmodified** 1/A(z) run continuously with block-switched coefficients. The synthesis filter's poles never move — the classical speech-processing complement to `formant`'s cepstral envelope preservation, built on a different mechanism (an explicit source-filter model instead of a magnitude-envelope correction).

```js
import { lpc } from '@audio/shift'

lpc(audio, { ratio: 1.5 })
lpc(audio, { ratio: 1.5, order: 24, frameSize: 512 })
```

| Param | Default | |
|---|---|---|
| `order` | `min(frameSize/16, round(2 + sr/1000))` | AR filter order (pole count) |
| `frameSize` | `1024` | Analysis/synthesis frame length |

**Preserves** formant frequencies by construction — the filter that carries them is never touched, only its excitation is repitched.<br>
**Destroys** pure tones by design: on a single sinusoid the AR envelope IS the partial, so the filter locks onto it and pitch barely moves — the family's defining tradeoff, not a bug.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 228.33 | 0.8 | 2.274 | 0.987 | 1.382 | 0.975 | 1.811 |

f0 err 228.33 Hz and alias 2.274 — both worst in the collection, and both the same degeneracy: on the alias test's 14 kHz tone (pushed toward Nyquist), the AR fit locks onto that single partial and the high-order synthesis filter rings into sharp amplitude spikes rather than shifting cleanly. Formant dist 1.382 is higher (worse) than `formant`'s 0.765 on this synthetic vowel too, across every `order` from 8 to 64 — the fitted envelope follows the fixture's individual harmonics as well as its three formants, where `formant`'s deliberately-smoothed cepstral envelope doesn't. None of this is the intended material: real, less strictly periodic speech is what an unmodified synthesis filter is for.

**Use when:** Speech/vocals where the formants must not move with pitch, and the material isn't a bare sustained tone.<br>
**Not for:** Pure tones, synth pads, or anything where the "partial" and the "envelope" are the same thing.


## Variable pitch

`vocoder`, `phaseLock`, `transient`, `formant`, `paulstretch`, `sms`, `hpss`, `sample`, `delay`, and `lpc` accept a time-varying `ratio` — a function `(t) => ratio` or a `Float32Array` (paired with `ratioDuration` in seconds, defaulting to the array's own length at `sampleRate`). `ola`, `wsola`, `psola`, `granular`, and `hybrid` apply a single global ratio and reject a variable one.

```js
// Vibrato: ±10% at 5 Hz
let vibrato = phaseLock(audio, {
  ratio: (t) => 1 + 0.1 * Math.sin(2 * Math.PI * 5 * t),
  sampleRate: 44100,
})
```

#### Pitch correction

Combine with a pitch detector: detect per-frame f0, snap to target scale, pass as `ratio` function. Use `formant` for natural voice, `phaseLock` for hard-tune effect, `sms` for harmonic instruments, `lpc` where formant fidelity matters most.

```js
import { yin } from '@audio/pitch'
import { formant } from '@audio/shift'

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

<details><summary>Full quality table</summary>

| Algorithm | f0 err | THD% | alias | stream corr | cent err | onset err | attack corr | formant dist | phase coh | shift |
|-----------|-------:|-----:|------:|------------:|---------:|----------:|------------:|-------------:|----------:|------:|
| `hpss` | 0.00 | 0.0 | 0.052 | 1.000 | 0.013 | 0.000 | **0.998** | 1.207 | 0.928 | **1.487** |
| `vocoder` | 0.00 | 0.0 | 0.000 | 1.000 | 0.009 | 0.000 | 0.981 | 1.158 | 0.928 | 1.553 |
| `formant` | 0.00 | 0.0 | 0.000 | 1.000 | 0.058 | 0.000 | 0.987 | **0.765** | **1.000** | 1.573 |
| `delay` | 1.10 | 0.1 | 0.028 | 1.000 | 0.004 | 0.000 | 0.995 | 2.445 | 0.940 | 1.610 |
| `sample` | 2.50 | 0.1 | 0.007 | 1.000 | 0.004 | 0.000 | 0.951 | 2.330 | 0.170 | 1.614 |
| `wsola` | 1.67 | 0.1 | 0.005 | 1.000 | 0.003 | 0.000 | 0.995 | 2.358 | 0.864 | 1.674 |
| `sms` | 0.00 | 0.0 | 0.002 | 1.000 | 0.002 | 0.000 | 0.963 | 1.845 | 0.929 | 1.701 |
| `phaseLock` | 0.00 | 0.0 | 0.000 | 1.000 | 0.008 | 0.000 | 0.984 | 1.423 | 0.999 | 1.755 |
| `pitchShift` | 0.00 | 0.0 | 0.000 | 1.000 | 0.008 | 0.000 | 0.984 | 1.423 | 0.999 | 1.755 |
| `transient` | 0.00 | 0.0 | 0.000 | 1.000 | 0.008 | 0.000 | 0.984 | 1.423 | 0.999 | 1.755 |
| `psola` | 0.66 | 0.2 | 0.005 | 1.000 | 0.003 | 0.000 | 0.941 | 2.336 | 0.998 | 1.766 |
| `lpc` | 228.33 | 0.8 | 2.274 | 1.000 | 0.265 | 0.000 | 0.987 | 1.382 | 0.975 | 1.811 |
| `hybrid` | 0.00 | 0.0 | 0.000 | 1.000 | 0.000 | 0.000 | 0.984 | 1.423 | 0.999 | 1.824 |
| `ola` | 38.33 | 0.2 | 0.004 | 1.000 | 0.042 | 0.388 | 0.980 | 2.342 | 0.995 | 2.025 |
| `paulstretch` | 0.00 | 0.2 | 0.230 | 1.000 | 0.043 | 0.000 | 0.935 | 7.371 | 0.518 | 2.221 |
| `granular` | 1.45 | 0.0 | 0.033 | 1.000 | 0.040 | 0.452 | 0.996 | 3.486 | 0.997 | 2.256 |

<details><summary>Column definitions</summary>

- **f0 err** (Hz) — pitch accuracy shifting 440→660 Hz sine.
- **THD%** — harmonic distortion on shifted pure sine.
- **alias** — energy above Nyquist when shifting 14 kHz ×2.
- **stream corr** — streaming vs batch correlation. 1.000 everywhere — see [Runtime behavior](#runtime-behavior).
- **cent err** — spectral centroid ratio error on a 3-partial chord.
- **onset err** — impulse-train period error after shift.
- **attack corr** — plucked-string attack envelope correlation. Bold = leader.
- **formant dist** — cepstral envelope distance on synthetic vowel. Lower = formants preserved. Bold = leader.
- **phase coh** — AM-envelope coherence on 5 Hz tremolo. Bold = leader.
- **shift** — log-magnitude distance to canonical shifted reference, averaged over four fixtures. Lower = better. Bold = leader.

</details>
</details>


## Dependencies

- [stretch](https://github.com/audiojs/stretch) — Time-domain stretchers, used by `ola`/`wsola`/`psola` only
- [fourier-transform](https://github.com/audiojs/fourier-transform) — FFT, used by the STFT family + `hybrid`

Every other algorithm (`granular`, `sample`, `delay`, `lpc`) owns its primitives directly — no FFT, no external stretcher.

## Migration from v0.0.0

Previously held by [mikolalysenko/pitch-shift](https://github.com/mikolalysenko/pitch-shift) (2013, v0.0.0) — a single WSOLA/TD-PSOLA implementation. Available here as [`wsola`](#algorithms) or [`psola`](#algorithms) with batch, streaming, and multi-channel support.

```js
// v0.0.0 (old)
var shifter = require('@audio/shift')(onData, t => ratio, { frameSize: 2048 })
shifter.feed(float32Array)

// v1 (this package)
import { wsola } from '@audio/shift'
let write = wsola({ ratio })
let out = write(float32Array)
let tail = write()  // flush
```

## Related

- [stretch](https://github.com/audiojs/stretch) — Time stretching
- [filter](https://github.com/audiojs/filter) — Audio filters


<p align="center"><a href="./license.md">MIT</a> · <a href="https://github.com/krishnized/license">ॐ</a></p>
