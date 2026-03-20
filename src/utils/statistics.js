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
