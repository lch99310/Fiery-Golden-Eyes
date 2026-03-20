/**
 * Formatting utilities for the Sydney House Prices app
 */

/** Format a price as $X,XXX,XXX or $X.XM */
export function formatPrice(price) {
  if (!price || isNaN(price)) return 'N/A'
  if (price >= 1_000_000) {
    return `$${(price / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  }
  if (price >= 1_000) {
    return `$${(price / 1_000).toFixed(0)}k`
  }
  return `$${price.toLocaleString('en-AU')}`
}

/** Full price with commas: $1,250,000 */
export function formatPriceFull(price) {
  if (!price) return 'N/A'
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    maximumFractionDigits: 0,
  }).format(price)
}

/** Format date as "15 Mar 2025" */
export function formatShortDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** Format date as "Mar 2025" */
export function formatMonthYear(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })
}

/** Convert price delta to color (positive = green, negative = red) */
export function deltaColor(delta) {
  if (delta > 0) return '#34d399'
  if (delta < 0) return '#f87171'
  return '#9aa0b8'
}

/** Format percent change */
export function formatPercent(value) {
  if (value == null) return ''
  const sign = value >= 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(1)}%`
}
