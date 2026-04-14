import { clamp, hannWindow, PI2 } from './util.js'

// Canonical WSOLA time-stretch primitive used by the time-domain pitch shifters
// (ola = delta 0, wsola = delta > 0, granular = simple OLA with a separate stretcher).
// Pitch shift = time-stretch by `factor` then resample back to the original length.

function overlapLength(frameSize, synHop, synPos, outLen) {
  return Math.max(0, Math.min(frameSize - synHop, synPos, outLen - synPos))
}

// WSOLA time-stretch. `factor` > 1 makes the signal longer at the same pitch.
// `delta` is the similarity search half-window (0 = OLA without search).
export function wsolaStretch(data, factor, opts = {}) {
  if (factor === 1 || data.length === 0) return new Float32Array(data)
  let frameSize = opts.frameSize ?? 2048
  let hopSize = opts.hopSize ?? (frameSize >> 2)
  let delta = opts.delta ?? (frameSize >> 2)
  let win = hannWindow(frameSize)
  let inLen = data.length
  let outLen = Math.max(1, Math.round(inLen * factor))
  let out = new Float32Array(outLen)
  let norm = new Float32Array(outLen)
  let synHop = hopSize
  let anaHop = hopSize / factor

  let anaPos = 0
  let synPos = 0
  while (synPos + frameSize <= outLen) {
    let nomPos = Math.round(anaPos)
    let readPos = nomPos

    if (synPos > 0 && delta > 0) {
      let searchStart = Math.max(0, nomPos - delta)
      let searchEnd = Math.min(inLen - frameSize, nomPos + delta)
      if (searchEnd < searchStart) break
      let overlap = overlapLength(frameSize, synHop, synPos, outLen)
      let bestCorr = -Infinity
      let bestS = searchStart
      for (let s = searchStart; s <= searchEnd; s++) {
        let corr = 0
        for (let i = 0; i < overlap; i++) corr += data[s + i] * out[synPos + i]
        if (corr > bestCorr) { bestCorr = corr; bestS = s }
      }
      readPos = bestS
    }

    if (readPos < 0 || readPos + frameSize > inLen) break

    for (let i = 0; i < frameSize; i++) {
      let w = win[i]
      out[synPos + i] += data[readPos + i] * w
      norm[synPos + i] += w
    }

    anaPos += anaHop
    synPos += synHop
  }

  for (let i = 0; i < outLen; i++) {
    if (norm[i] > 1e-8) out[i] /= norm[i]
  }
  return out
}

// Pitch-Synchronous OLA time-stretch. Detects a per-frame pitch period via autocorrelation,
// places pitch marks on waveform peaks, and overlap-adds 2-period grains at output marks
// spaced by the local period so cycles stay coherent under stretching. Falls back to
// wsolaStretch for unvoiced / weakly-voiced material. Adapted from the canonical
// time-stretch/psola.js (Serra-school TD-PSOLA with median-smoothed contour).
export function psolaStretch(data, factor, opts = {}) {
  if (factor === 1 || data.length === 0) return new Float32Array(data)
  let sr = opts.sampleRate || 44100
  let minP = Math.floor(sr / (opts.maxFreq || 500))
  let maxP = Math.ceil(sr / (opts.minFreq || 80))
  let defP = Math.round((minP + maxP) / 2)
  let n = data.length
  let outLen = Math.max(1, Math.round(n * factor))
  if (n < maxP * 6) return wsolaStretch(data, factor, opts)

  let contour = pitchContour(data, minP, maxP, defP)
  if (!contour) return wsolaStretch(data, factor, opts)

  let { markPos, periods, voiced } = pitchMarks(data, contour, minP, maxP)
  if (markPos.length < 4) return wsolaStretch(data, factor, opts)

  let voicedCount = 0
  for (let i = 0; i < voiced.length; i++) if (voiced[i]) voicedCount++
  if (voicedCount < Math.max(4, voiced.length * 0.2)) return wsolaStretch(data, factor, opts)

  let { out, norm } = renderPsola(data, outLen, factor, markPos, periods, voiced, minP, maxP)
  let anyNorm = false
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-8) { anyNorm = true; break }
  if (!anyNorm) return wsolaStretch(data, factor, opts)

  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-8) out[i] /= norm[i]

  // Blend wsola in weakly-voiced regions where pitch-synchronous grains alone sound brittle.
  if (voicedCount < voiced.length * 0.95) {
    let noise = wsolaStretch(data, factor, opts)
    for (let i = 0; i < outLen; i++) {
      let w = voicedWeightAt(contour, i / factor)
      out[i] = out[i] * w + noise[i] * (1 - w)
    }
  }
  return out
}

function detectPeriodRange(data, pos, minLag, maxLag, prevPeriod) {
  if (minLag > maxLag) return { period: 0, score: 0 }
  let corr = new Float64Array(maxLag + 2)
  let n = maxLag
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, e1 = 0, e2 = 0
    for (let i = 0; i < n; i++) {
      let a = data[pos + i], b = data[pos + i + lag]
      sum += a * b
      e1 += a * a
      e2 += b * b
    }
    let d = Math.sqrt(e1 * e2)
    corr[lag] = d > 1e-10 ? sum / d : 0
  }
  let best = 0, bestScore = 0, bestMetric = -Infinity
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] < 0.3 || corr[lag] < corr[lag - 1] || corr[lag] < corr[lag + 1]) continue
    let score = corr[lag]
    let metric = score
    if (prevPeriod > 0) metric += 0.18 * Math.max(-1, 1 - Math.abs(Math.log(lag / prevPeriod)))
    let doubled = lag * 2
    if (doubled < maxLag && corr[doubled] >= score * 0.88 && corr[doubled] >= corr[doubled - 1] && corr[doubled] >= corr[doubled + 1]) {
      let dm = corr[doubled]
      if (prevPeriod > 0) dm += 0.18 * Math.max(-1, 1 - Math.abs(Math.log(doubled / prevPeriod)))
      if (dm > metric) { lag = doubled; score = corr[lag]; metric = dm }
    }
    if (metric > bestMetric) { bestMetric = metric; bestScore = score; best = lag }
  }
  if (!best) {
    let bv = -Infinity
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (corr[lag] > bv) { bv = corr[lag]; best = lag; bestScore = corr[lag] }
    }
  }
  if (bestScore <= 0.35 || !best) return { period: 0, score: Math.max(0, bestScore) }
  let period = best
  if (best > minLag && best < maxLag) {
    let ym1 = corr[best - 1], y0 = corr[best], yp1 = corr[best + 1]
    let denom = ym1 - 2 * y0 + yp1
    if (Math.abs(denom) > 1e-8) period += clamp(0.5 * (ym1 - yp1) / denom, -0.5, 0.5)
  }
  return { period, score: bestScore }
}

function detectPeriod(data, pos, minP, maxP, end, prevPeriod) {
  if (pos + maxP * 2 > end) return { period: 0, score: 0 }
  if (prevPeriod > 0) {
    let lo = clamp(Math.floor(prevPeriod * 0.78), minP, maxP)
    let hi = clamp(Math.ceil(prevPeriod * 1.28), minP, maxP)
    let local = detectPeriodRange(data, pos, lo, hi, prevPeriod)
    if (local.score >= 0.58) return local
  }
  return detectPeriodRange(data, pos, minP, maxP, prevPeriod)
}

function peakNear(data, center, radius) {
  let start = Math.max(1, center - radius)
  let end = Math.min(data.length - 2, center + radius)
  let best = clamp(Math.round(center), start, end)
  let bestVal = -Infinity
  for (let i = start; i <= end; i++) {
    let v = Math.abs(data[i])
    if (v >= Math.abs(data[i - 1]) && v >= Math.abs(data[i + 1])) {
      let score = v - 0.08 * Math.abs(i - center) / Math.max(1, radius)
      if (score > bestVal) { best = i; bestVal = score }
    }
  }
  if (bestVal > -Infinity) return best
  for (let i = start; i <= end; i++) {
    let score = Math.abs(data[i]) - 0.08 * Math.abs(i - center) / Math.max(1, radius)
    if (score > bestVal) { best = i; bestVal = score }
  }
  return best
}

function smoothPeriods(periods, voiced, defP) {
  if (!periods.length) return periods
  let out = periods.slice()
  for (let pass = 0; pass < 2; pass++) {
    let next = out.slice()
    for (let i = 0; i < out.length; i++) {
      if (!voiced[i]) continue
      let win = []
      for (let k = Math.max(0, i - 2); k <= Math.min(out.length - 1, i + 2); k++) {
        if (voiced[k]) win.push(out[k])
      }
      if (win.length < 3) continue
      win.sort((a, b) => a - b)
      let med = win[Math.floor(win.length / 2)]
      next[i] = clamp(0.6 * out[i] + 0.4 * med, med * 0.75, med * 1.35)
    }
    out = next
  }
  let firstVoiced = out.findIndex((_, i) => voiced[i])
  let seed = firstVoiced >= 0 ? out[firstVoiced] : defP
  let prev = seed
  for (let i = 0; i < out.length; i++) {
    if (voiced[i]) { out[i] = clamp(out[i], prev * 0.8, prev * 1.25); prev = out[i] }
    else out[i] = prev || seed
  }
  let next = prev || seed
  for (let i = out.length - 1; i >= 0; i--) {
    if (voiced[i]) next = out[i]
    else out[i] = next || seed
  }
  return out
}

function pitchContour(data, minP, maxP, defP) {
  let start = maxP * 2
  let end = data.length - maxP * 2
  if (end <= start) return null
  let hop = Math.max(12, Math.floor(minP * 0.75))
  let periods = [], scores = [], voiced = []
  let prevPeriod = defP
  for (let center = start; center <= end; center += hop) {
    let { period, score } = detectPeriod(data, center - maxP, minP, maxP, data.length, prevPeriod)
    // 0.72 cleanly separates monophonic harmonic material (pure tone ≈1.00, vowel ≈1.00)
    // from polyphonic content (equal-amp 3-tone chord peaks at ~0.58) — the latter forces
    // the wsola fallback instead of letting psola place pitch-synchronous grains on a
    // period that only tracks the dominant component.
    let isVoiced = score >= 0.72 && period > 0
    periods.push(isVoiced ? period : prevPeriod)
    scores.push(score)
    voiced.push(isVoiced)
    if (isVoiced) prevPeriod = period
  }
  return { start, hop, periods: smoothPeriods(periods, voiced, defP), scores, voiced }
}

function periodAt(contour, pos) {
  let x = (pos - contour.start) / contour.hop
  if (x <= 0) return contour.periods[0]
  if (x >= contour.periods.length - 1) return contour.periods[contour.periods.length - 1]
  let i = Math.floor(x)
  let frac = x - i
  return contour.periods[i] * (1 - frac) + contour.periods[i + 1] * frac
}

function voicedAt(contour, pos) {
  let i = clamp(Math.round((pos - contour.start) / contour.hop), 0, contour.voiced.length - 1)
  return contour.voiced[i] && contour.scores[i] >= 0.4
}

function voicedWeight(contour, index) {
  if (!contour.voiced[index]) return 0
  let sum = 0, count = 0
  for (let k = Math.max(0, index - 1); k <= Math.min(contour.scores.length - 1, index + 1); k++) {
    if (!contour.voiced[k]) continue
    sum += clamp((contour.scores[k] - 0.34) / 0.18, 0, 1)
    count++
  }
  return count ? sum / count : 0
}

function voicedWeightAt(contour, pos) {
  let x = (pos - contour.start) / contour.hop
  if (x <= 0) return voicedWeight(contour, 0)
  if (x >= contour.scores.length - 1) return voicedWeight(contour, contour.scores.length - 1)
  let i = Math.floor(x)
  let frac = x - i
  return voicedWeight(contour, i) * (1 - frac) + voicedWeight(contour, i + 1) * frac
}

function findAnchor(contour) {
  for (let i = 1; i < contour.voiced.length - 1; i++) {
    if (contour.voiced[i - 1] && contour.voiced[i] && contour.voiced[i + 1]) return i
  }
  let best = -1, bestScore = 0
  for (let i = 0; i < contour.voiced.length; i++) {
    if (contour.voiced[i] && contour.scores[i] > bestScore) { best = i; bestScore = contour.scores[i] }
  }
  return best
}

function pitchMarks(data, contour, minP, maxP) {
  let anchorIdx = findAnchor(contour)
  if (anchorIdx < 0) return { markPos: [], periods: [], voiced: [] }
  let anchorCenter = contour.start + anchorIdx * contour.hop
  let anchorPeriod = periodAt(contour, anchorCenter)
  let anchorMark = peakNear(data, anchorCenter, Math.max(4, Math.floor(anchorPeriod * 0.35)))

  let headM = [], headP = [], headV = []
  let pos = anchorMark
  while (pos > minP) {
    let period = periodAt(contour, pos)
    let predicted = pos - period
    if (predicted <= 0) break
    let nextPeriod = periodAt(contour, predicted)
    let isVoiced = voicedAt(contour, predicted)
    let radius = Math.max(4, Math.floor(nextPeriod * 0.35))
    let mark = isVoiced ? peakNear(data, predicted, radius) : Math.round(predicted)
    let minStep = Math.max(1, Math.floor(nextPeriod * 0.55))
    let maxStep = Math.max(minStep + 1, Math.ceil(nextPeriod * 1.8))
    let step = pos - mark
    if (step < minStep) mark = pos - minStep
    if (step > maxStep) mark = pos - maxStep
    if (mark <= 0 || mark >= pos) break
    headM.push(mark); headP.push(nextPeriod); headV.push(isVoiced)
    pos = mark
  }
  let markPos = headM.reverse()
  let periods = headP.reverse()
  let voiced = headV.reverse()
  markPos.push(anchorMark); periods.push(anchorPeriod); voiced.push(true)

  pos = anchorMark
  while (pos + minP < data.length) {
    let period = periodAt(contour, pos)
    let predicted = pos + period
    if (predicted + minP >= data.length) break
    let nextPeriod = periodAt(contour, predicted)
    let isVoiced = voicedAt(contour, predicted)
    let radius = Math.max(4, Math.floor(nextPeriod * 0.35))
    let mark = isVoiced ? peakNear(data, predicted, radius) : Math.round(predicted)
    let minStep = Math.max(1, Math.floor(nextPeriod * 0.55))
    let maxStep = Math.max(minStep + 1, Math.ceil(nextPeriod * 1.8))
    let step = mark - pos
    if (step < minStep) mark = pos + minStep
    if (step > maxStep) mark = pos + maxStep
    if (mark <= pos || mark >= data.length) break
    markPos.push(mark); periods.push(nextPeriod); voiced.push(isVoiced)
    pos = mark
  }
  return { markPos, periods, voiced }
}

function addGrain(data, srcPos, left, right, out, norm, dstPos) {
  left = Math.max(1, Math.round(left))
  right = Math.max(1, Math.round(right))
  let len = left + right
  for (let i = -left; i < right; i++) {
    let si = srcPos + i
    let di = dstPos + i
    if (si < 0 || si >= data.length || di < 0 || di >= out.length) continue
    let phase = (i + left) / len
    let w = 0.5 * (1 - Math.cos(PI2 * phase))
    out[di] += data[si] * w
    norm[di] += w
  }
}

function renderPsola(data, outLen, factor, markPos, periods, voiced, minP, maxP) {
  let out = new Float32Array(outLen)
  let norm = new Float32Array(outLen)
  if (!markPos.length) return { out, norm }
  let synPos = Math.round(markPos[0] * factor)
  let cursor = 0
  let last = markPos.length - 1
  while (synPos < outLen) {
    let srcTime = synPos / factor
    if (srcTime > markPos[last] + periods[last]) break
    while (cursor + 1 < markPos.length && markPos[cursor + 1] <= srcTime) cursor++
    let best = cursor
    if (cursor + 1 < markPos.length && Math.abs(markPos[cursor + 1] - srcTime) < Math.abs(markPos[cursor] - srcTime)) best = cursor + 1
    let left = best > 0 ? markPos[best] - markPos[best - 1] : periods[best]
    let right = best < last ? markPos[best + 1] - markPos[best] : periods[best]
    left = clamp(left, minP, maxP * 2)
    right = clamp(right, minP, maxP * 2)
    addGrain(data, markPos[best], left, right, out, norm, Math.round(synPos))
    let step = voiced[best] ? periods[best] : 0.5 * (left + right)
    synPos += clamp(step, minP * 0.75, maxP * 1.25)
  }
  return { out, norm }
}

