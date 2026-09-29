/**
 * Simple statistical utilities for property price analysis
 */

/** Compute median of an array of numbers */
export function median(arr) {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** Compute average (mean) */
export function average(arr) {
  if (!arr.length) return 0
  return arr.reduce((sum, v) => sum + v, 0) / arr.length
}

/** Trimmed mean: drop the top and bottom `frac` of values before averaging,
 * so a handful of extreme sales don't drag the average. Falls back to the
 * plain mean when the sample is too small to trim meaningfully. */
export function trimmedMean(arr, frac = 0.05) {
  if (arr.length < 10) return average(arr)
  const sorted = [...arr].sort((a, b) => a - b)
  const cut = Math.floor(sorted.length * frac)
  const kept = sorted.slice(cut, sorted.length - cut)
  return average(kept.length ? kept : sorted)
}

/** Simple Ordinary Least Squares linear regression
 * Returns { slope, intercept, r2 }
 */
export function linearRegression(xs, ys) {
  const n = xs.length
  if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 }

  const meanX = xs.reduce((s, x) => s + x, 0) / n
  const meanY = ys.reduce((s, y) => s + y, 0) / n

  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY)
    sxx += (xs[i] - meanX) ** 2
    syy += (ys[i] - meanY) ** 2
  }

  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = meanY - slope * meanX
  const r2 = syy === 0 ? 0 : (sxy ** 2) / (sxx * syy)

  return { slope, intercept, r2 }
}

/** Compute percentile (0-100) */
export function percentile(arr, p) {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** Compute standard deviation */
export function stddev(arr) {
  if (arr.length < 2) return 0
  const avg = average(arr)
  const variance = arr.reduce((s, v) => s + (v - avg) ** 2, 0) / (arr.length - 1)
  return Math.sqrt(variance)
}

/** Weighted quantile (0-1) using midpoint cumulative weights, interpolated. */
export function weightedQuantile(values, weights, q) {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  const total = weights.reduce((s, w) => s + w, 0)
  if (!idx.length || total <= 0) return NaN
  let acc = 0
  let prevPos = null
  let prevVal = null
  for (const i of idx) {
    const pos = (acc + weights[i] / 2) / total
    acc += weights[i]
    if (pos >= q) {
      if (prevPos === null) return values[i]
      return prevVal + (values[i] - prevVal) * (q - prevPos) / (pos - prevPos)
    }
    prevPos = pos
    prevVal = values[i]
  }
  return prevVal
}

/** Adaptive running median with P25/P75 band, for noisy price-vs-time data.
 *
 * At each of `grid` evenly spaced x positions, takes tricube-weighted
 * quantiles of ys. The window half-width is the larger of `minHalfWidth` and
 * the distance to the k-th nearest point (k = max(minPoints, frac·n)), so
 * sparse data automatically gets a wider, flatter window instead of chasing
 * noise. Pass log prices as ys and exponentiate the result — prices are
 * roughly log-normal, so this keeps a few expensive sales from dragging it.
 *
 * Returns [{ x, median, p25, p75 }].
 */
export function runningQuantiles(xs, ys, {
  minPoints = 30, frac = 0.25, minHalfWidth = 30, grid = 60,
} = {}) {
  const n = xs.length
  if (n < 2) return []
  const k = Math.min(n, Math.max(minPoints, Math.floor(frac * n)))
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const out = []
  const dist = new Array(n)
  for (let g = 0; g < grid; g++) {
    const x = grid === 1 ? xMin : xMin + (xMax - xMin) * g / (grid - 1)
    for (let i = 0; i < n; i++) dist[i] = Math.abs(xs[i] - x)
    const kth = [...dist].sort((a, b) => a - b)[k - 1]
    const h = Math.max(minHalfWidth, kth * 1.0001)
    const vals = []
    const ws = []
    for (let i = 0; i < n; i++) {
      const u = dist[i] / h
      if (u < 1) {
        vals.push(ys[i])
        ws.push((1 - u ** 3) ** 3)
      }
    }
    out.push({
      x,
      median: weightedQuantile(vals, ws, 0.5),
      p25: weightedQuantile(vals, ws, 0.25),
      p75: weightedQuantile(vals, ws, 0.75),
    })
  }
  return out
}

/** Small seeded PRNG so bootstrap results are stable across re-renders. */
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** OLS slope of ys on xs plus a bootstrap confidence interval.
 * `significant` is true when the (1 - 2·alpha) interval excludes zero.
 * Returns { slope, lo, hi, significant }.
 */
export function bootstrapSlope(xs, ys, { iterations = 200, alpha = 0.05, seed = 1 } = {}) {
  const n = xs.length
  const { slope } = linearRegression(xs, ys)
  if (n < 3) return { slope, lo: slope, hi: slope, significant: false }
  const rand = mulberry32(seed)
  const slopes = []
  const bx = new Array(n)
  const by = new Array(n)
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rand() * n)
      bx[i] = xs[j]
      by[i] = ys[j]
    }
    slopes.push(linearRegression(bx, by).slope)
  }
  const lo = percentile(slopes, alpha * 100)
  const hi = percentile(slopes, (1 - alpha) * 100)
  return { slope, lo, hi, significant: lo > 0 || hi < 0 }
}
