import { fft, ifft } from 'fourier-transform'
import { winSqFloor } from './stft.js'
import { PI2, hannWindow, makeFrameRatio, matchGain, wrapPhase, makePitchShift, resolveRatio, bufferedStream } from './util.js'

// Harmonic/Percussive Source Separation (Fitzgerald 2010) + per-component pitch shift.
//
// Canonical form:
//   1. STFT analysis → magnitude spectrogram |X|.
//   2. Time-axis median filter  (per-bin, across frames)   → Mh, a harmonic-friendly view.
//   3. Freq-axis median filter  (per-frame, across bins)  → Mp, a percussive-friendly view.
//   4. Soft Wiener-style mask at exponent `power`:
//        Hk = Mh^p / (Mh^p + Mp^p),   Pk = Mp^p / (Mh^p + Mp^p)
//   5. Harmonic component Xh = Hk · X is shifted with a phase-vocoder (bin-shift scatter,
//      sum-magnitudes / loudest-wins-frequency for phase advance — identical pattern to
//      vocoder.js so streaming and batch match by construction).
//   6. Percussive component Xp = Pk · X passes through with its original phase, preserving
//      attack localization exactly.
//   7. Output = iSTFT(Xh_shifted) + iSTFT(Xp).
//
// Transients survive unmoved; tonals shift in pitch. A purely harmonic signal behaves like
// the vocoder; a purely percussive signal passes through untouched.

function medianSort(buf, len) {
  let arr = buf.subarray(0, len)
  // Insertion sort — small windows (~17), faster than generic sort on TypedArrays.
  for (let i = 1; i < len; i++) {
    let v = arr[i], j = i - 1
    while (j >= 0 && arr[j] > v) { arr[j + 1] = arr[j]; j-- }
    arr[j + 1] = v
  }
  let m = len >> 1
  return len & 1 ? arr[m] : 0.5 * (arr[m - 1] + arr[m])
}

function hpssBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let N = opts?.frameSize ?? 2048
  let hop = opts?.hopSize ?? (N >> 2)
  let half = N >> 1
  let kTime = opts?.hpssTimeWidth ?? 17
  let kFreq = opts?.hpssFreqWidth ?? 17
  if ((kTime & 1) === 0) kTime += 1
  if ((kFreq & 1) === 0) kFreq += 1
  let power = opts?.hpssPower ?? 2
  let win = hannWindow(N)
  let freqPerBin = PI2 / N
  let sr = opts?.sampleRate || 44100
  let fr = makeFrameRatio(ratioFn || ratio)

  let pad = N
  let padded = new Float32Array(data.length + pad * 2)
  padded.set(data, pad)
  let nFrames = Math.max(1, Math.floor((padded.length - N) / hop) + 1)

  // Analyze all frames into mag/phase matrices.
  let magM = new Array(nFrames)
  let phM = new Array(nFrames)
  let scratch = new Float64Array(N)
  for (let f = 0; f < nFrames; f++) {
    let pos = f * hop
    for (let i = 0; i < N; i++) scratch[i] = (padded[pos + i] || 0) * win[i]
    let [re, im] = fft(scratch)
    let mag = new Float64Array(half + 1)
    let ph = new Float64Array(half + 1)
    for (let k = 0; k <= half; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      ph[k] = Math.atan2(im[k], re[k])
    }
    magM[f] = mag
    phM[f] = ph
  }

  // Time-axis median → harmonic estimate Mh.
  let Mh = new Array(nFrames)
  for (let f = 0; f < nFrames; f++) Mh[f] = new Float64Array(half + 1)
  let rT = kTime >> 1
  let colBuf = new Float64Array(kTime)
  for (let k = 0; k <= half; k++) {
    for (let f = 0; f < nFrames; f++) {
      let c = 0
      let a = Math.max(0, f - rT)
      let b = Math.min(nFrames - 1, f + rT)
      for (let g = a; g <= b; g++) colBuf[c++] = magM[g][k]
      Mh[f][k] = medianSort(colBuf, c)
    }
  }

  // Freq-axis median → percussive estimate Mp.
  let Mp = new Array(nFrames)
  for (let f = 0; f < nFrames; f++) Mp[f] = new Float64Array(half + 1)
  let rF = kFreq >> 1
  let rowBuf = new Float64Array(kFreq)
  for (let f = 0; f < nFrames; f++) {
    let mag = magM[f]
    let pm = Mp[f]
    for (let k = 0; k <= half; k++) {
      let c = 0
      let a = Math.max(0, k - rF)
      let b = Math.min(half, k + rF)
      for (let g = a; g <= b; g++) rowBuf[c++] = mag[g]
      pm[k] = medianSort(rowBuf, c)
    }
  }

  // Per-frame: split via soft mask, vocoder-shift H, pass-through P, resynth combined.
  let outPadded = new Float32Array(padded.length)
  let norm = new Float32Array(padded.length)
  let syn = new Float64Array(half + 1)
  let newFlat = new Float64Array(half + 1)
  let newFreq = new Float64Array(half + 1)
  let hMag = new Float64Array(half + 1)
  let pMag = new Float64Array(half + 1)
  let re = new Float64Array(half + 1)
  let im = new Float64Array(half + 1)
  let newPMag = new Float64Array(half + 1)
  let newPPhase = new Float64Array(half + 1)
  let pShifted = new Uint8Array(half + 1)

  for (let f = 0; f < nFrames; f++) {
    let r = fr.at(f * hop - pad, sr)
    let mag = magM[f]
    let ph = phM[f]
    let mh = Mh[f]
    let mp = Mp[f]

    for (let k = 0; k <= half; k++) {
      let hp = Math.pow(mh[k], power)
      let pp = Math.pow(mp[k], power)
      let sum = hp + pp + 1e-12
      let maskH = hp / sum
      hMag[k] = mag[k] * maskH
      pMag[k] = mag[k] * (1 - maskH)
    }

    newFlat.fill(0)
    newFreq.fill(0)
    newPMag.fill(0)
    newPPhase.fill(0)
    pShifted.fill(0)

    // Peak-gate the harmonic component's scatter. Only bins at or adjacent (±1) to a local
    // magnitude peak are eligible — bins between chord partials have unreliable phase
    // derivatives that produce frame-rate soft clicks when scattered. See vocoder.js for
    // the full explanation. Peak detection uses the pre-mask `mag` (not post-mask `hMag`)
    // because the median-filtered Wiener mask fluctuates frame-to-frame, making post-mask
    // peaks unstable and causing intermittent scatter → phase jumps → crackling on chords.
    //
    // The percussive component is shifted to the same dest bins as the harmonic. Without
    // this, harmonic energy that leaks through the soft mask passes through unshifted,
    // creating an audible ghost at the original pitch — especially on voice, where the
    // H/P separation is inherently leaky.
    let maxM = 0
    for (let k = 0; k <= half; k++) if (mag[k] > maxM) maxM = mag[k]
    let peakFloor = Math.max(1e-8, maxM * 0.005)

    let prevPh = f > 0 ? phM[f - 1] : null
    for (let k = 0; k <= half; k++) {
      let eligible = false
      for (let d = -1; d <= 1; d++) {
        let j = k + d
        if (j <= 0 || j >= half) continue
        if (mag[j] >= peakFloor && mag[j] > mag[j - 1] && mag[j] > mag[j + 1]) { eligible = true; break }
      }
      if (!eligible) continue

      let trueFreq
      if (!prevPh) {
        trueFreq = k * freqPerBin
      } else {
        let dp = wrapPhase(ph[k] - prevPh[k] - k * freqPerBin * hop)
        trueFreq = k * freqPerBin + dp / hop
      }
      let shifted = trueFreq * r
      let destBin = Math.round(shifted / freqPerBin)
      if (destBin < 0 || destBin > half) continue
      if (hMag[k] > newFlat[destBin]) {
        newFlat[destBin] = hMag[k]
        newFreq[destBin] = shifted
      }
      // Shift percussive into the same dest bin, preserving original phase.
      // This prevents harmonic leakage in the percussive mask from creating
      // a ghost voice at the original pitch.
      pShifted[k] = 1
      if (pMag[k] > newPMag[destBin]) {
        newPMag[destBin] = pMag[k]
        newPPhase[destBin] = ph[k]
      }
    }

    for (let k = 0; k <= half; k++) syn[k] = wrapPhase(syn[k] + newFreq[k] * hop)

    for (let k = 0; k <= half; k++) {
      let hm = newFlat[k]
      let pm = newPMag[k]
      re[k] = hm * Math.cos(syn[k]) + pm * Math.cos(newPPhase[k])
      im[k] = hm * Math.sin(syn[k]) + pm * Math.sin(newPPhase[k])
      // Non-peak percussive bins pass through unshifted (broadband transient energy)
      if (!pShifted[k]) {
        re[k] += pMag[k] * Math.cos(ph[k])
        im[k] += pMag[k] * Math.sin(ph[k])
      }
    }

    let sf = ifft(re, im)
    let pos = f * hop
    for (let i = 0; i < N; i++) {
      outPadded[pos + i] += sf[i] * win[i]
      norm[pos + i] += win[i] * win[i]
    }
  }

  let result = new Float32Array(data.length)
  let normFloor = winSqFloor(win, hop)
  for (let i = 0; i < data.length; i++) {
    let j = i + pad
    let n = norm[j] < normFloor ? normFloor : norm[j]
    result[i] = n > 1e-10 ? outPadded[j] / n : 0
  }
  return matchGain(result, data)
}

// Median filters need centered time windows — buffer input and run batch on flush.
let hpssStream = (opts) => bufferedStream(hpssBatch, opts)

export default makePitchShift(hpssBatch, hpssStream)
