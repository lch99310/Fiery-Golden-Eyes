import React, { useMemo, useState } from 'react'
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
  Area,
  ComposedChart,
} from 'recharts'
import { formatPrice, formatShortDate } from '../utils/formatters'
import { percentile, runningQuantiles, bootstrapSlope } from '../utils/statistics'

// Hide extreme outliers per property type so a single $23M sale doesn't
// flatten the whole chart. Uses a Tukey fence (3×IQR beyond the quartiles),
// which adapts to each group's own spread — a fixed percentage can't handle
// fat tails. Stats in the panel above stay untrimmed.
const IQR_FENCE = 3
const TRIM_MIN_POINTS = 20

// Trend = adaptive running median of log(price) with a P25–P75 band (see
// runningQuantiles). Types with fewer sales than this get no trend at all —
// a line through a handful of points is noise dressed up as signal.
const TREND_MIN_POINTS = 20
// Windows shorter than this report change over the period instead of an
// annualised rate, which would wildly exaggerate a few months' drift.
const ANNUALISE_MIN_MONTHS = 6
// A significant trend is only quoted as a number when its bootstrap interval
// is this tight (± percentage points); otherwise it reads "likely rising".
const MAX_QUOTED_HALF_WIDTH = 10
// Cap the y-axis at this percentile of the trended types (×headroom) so a
// few extreme sales, or a sparse type like Commercial, can't flatten the rest.
const Y_CAP_PERCENTILE = 97
const Y_CAP_HEADROOM = 1.15

const TYPE_COLORS = {
  House: '#4f6ef7',
  Unit: '#34d399',
  Townhouse: '#fbbf24',
  Land: '#a78bfa',
  Commercial: '#f87171',
}

// Round-number y-axis ticks from 0 up to at least `v`, about 4 intervals
function niceTicks(v) {
  const raw = v / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m * mag >= raw) * mag
  const n = Math.ceil(v / step - 1e-9)
  return Array.from({ length: n + 1 }, (_, i) => i * step)
}

function CustomDot({ cx, cy, fill }) {
  // Small and faint so the trend lines stay readable over hundreds of sales
  return <circle cx={cx} cy={cy} r={2.5} fill={fill} fillOpacity={0.35} />
}

// Headline for a type's trend: { text, detail } where detail holds the
// bootstrap range for the hover title.
function describeTrend(trend, months) {
  if (!trend) return null
  if (trend.tooFew) return { text: 'too few for trend', detail: `Needs at least ${TREND_MIN_POINTS} sales` }
  const perPeriod = months < ANNUALISE_MIN_MONTHS
  const days = perPeriod ? trend.spanDays : 365
  const toPct = slope => (Math.exp(slope * days) - 1) * 100
  const [pct, lo, hi] = [trend.slope, trend.lo, trend.hi].map(toPct)
  const unit = perPeriod ? '% over period' : '%/yr'
  const fmt = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
  const detail = `${fmt(pct)}${unit} (90% range ${fmt(lo)} to ${fmt(hi)})`
  if (!trend.significant) return { text: 'no clear trend', detail }
  if ((hi - lo) / 2 > MAX_QUOTED_HALF_WIDTH) {
    return { text: pct >= 0 ? 'likely rising' : 'likely falling', detail }
  }
  return { text: `${fmt(pct)}${unit}`, detail }
}

function CustomTooltip({ active, payload, unitPrice }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  // Trend line / band points have no address — only sales get a tooltip
  if (!d?.address) return null

  const pricePerSqm = d.area > 0 ? Math.round(d.price / d.area) : null

  return (
    <div style={{
      background: '#1a1d27',
      border: '1px solid #2e3350',
      borderRadius: 6,
      padding: '10px 14px',
      fontSize: 12,
    }}>
      <div style={{ color: '#e8eaf0', fontWeight: 600, marginBottom: 4 }}>
        {d.address}
      </div>
      <div style={{ color: TYPE_COLORS[d.type] || '#4f6ef7' }}>{d.type}</div>
      <div style={{ color: '#e8eaf0', fontSize: 14, fontWeight: 700, marginTop: 4 }}>
        {unitPrice && pricePerSqm != null
          ? `$${pricePerSqm.toLocaleString()}/m²`
          : formatPrice(d.price)}
      </div>
      <div style={{ color: '#9aa0b8', marginTop: 2 }}>{formatShortDate(d.date)}</div>
      {d.area > 0 && <div style={{ color: '#9aa0b8' }}>{d.area.toLocaleString()} m²</div>}
    </div>
  )
}

export default function PriceChart({ properties, filters }) {
  const [unitPrice, setUnitPrice] = useState(false)

  // Convert dates to numeric (days since start)
  const chartData = useMemo(() => {
    if (!properties.length) return { points: [], trends: {}, dateRange: [null, null] }

    // In unit price mode, only include properties with valid area
    const filtered = unitPrice
      ? properties.filter(p => p.area > 0)
      : properties

    if (!filtered.length) return { points: [], trends: {}, dateRange: [null, null] }

    const sorted = [...filtered].sort((a, b) => new Date(a.date) - new Date(b.date))
    const minDate = new Date(sorted[0].date).getTime()
    const maxDate = new Date(sorted[sorted.length - 1].date).getTime()

    let points = sorted.map(p => ({
      ...p,
      xNum: (new Date(p.date).getTime() - minDate) / (1000 * 60 * 60 * 24), // days
      timestamp: new Date(p.date).getTime(),
      pricePerSqm: p.area > 0 ? Math.round(p.price / p.area) : null,
    }))

    const getValue = (p) => unitPrice ? p.pricePerSqm : p.price

    // Trim extreme tails within each type (Unit vs Unit, House vs House…)
    let trimmedCount = 0
    const byType = {}
    points.forEach(p => {
      if (getValue(p) == null) return
      if (!byType[p.type]) byType[p.type] = []
      byType[p.type].push(p)
    })
    const kept = []
    Object.values(byType).forEach(typePoints => {
      if (typePoints.length < TRIM_MIN_POINTS) {
        kept.push(...typePoints)
        return
      }
      const values = typePoints.map(getValue)
      const q1 = percentile(values, 25)
      const q3 = percentile(values, 75)
      const iqr = q3 - q1
      const lo = q1 - IQR_FENCE * iqr
      const hi = q3 + IQR_FENCE * iqr
      typePoints.forEach(p => {
        const v = getValue(p)
        if (v >= lo && v <= hi) kept.push(p)
        else trimmedCount++
      })
    })
    points = kept.sort((a, b) => a.timestamp - b.timestamp)

    // Trend per visible type: running median + IQR band in log space,
    // plus a bootstrap-tested log-slope for the headline % change.
    const trends = {}
    const capValues = []
    filters.types.forEach(type => {
      const typePoints = points.filter(p => p.type === type && getValue(p) > 0)
      if (!typePoints.length) return
      if (typePoints.length < TREND_MIN_POINTS) {
        trends[type] = { tooFew: true }
        return
      }
      const xs = typePoints.map(p => p.xNum)
      const logYs = typePoints.map(p => Math.log(getValue(p)))
      const curve = runningQuantiles(xs, logYs).map(c => ({
        x: c.x,
        y: Math.exp(c.median),
        band: [Math.exp(c.p25), Math.exp(c.p75)],
      }))
      const { slope, lo, hi, significant } = bootstrapSlope(xs, logYs)
      trends[type] = {
        curve,
        slope,
        lo,
        hi,
        significant,
        spanDays: Math.max(...xs) - Math.min(...xs),
      }
      capValues.push(percentile(typePoints.map(getValue), Y_CAP_PERCENTILE))
    })
    const yTicks = capValues.length ? niceTicks(Math.max(...capValues) * Y_CAP_HEADROOM) : null
    const yMax = yTicks ? yTicks[yTicks.length - 1] : null
    const clippedCount = yMax == null ? 0 : points.filter(p => getValue(p) > yMax).length

    // Date ticks: split into 6 evenly spaced ticks
    const totalDays = (maxDate - minDate) / (1000 * 60 * 60 * 24)
    const tickInterval = totalDays / 5
    const ticks = Array.from({ length: 6 }, (_, i) => Math.round(i * tickInterval))

    return {
      points,
      trends,
      yMax,
      yTicks,
      clippedCount,
      ticks,
      minDate,
      trimmedCount,
      dateFormatter: (dayNum) => {
        const d = new Date(minDate + dayNum * 24 * 60 * 60 * 1000)
        // Short windows would repeat the same month label, so show the day
        return totalDays < 180
          ? d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
          : d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
      },
    }
  }, [properties, filters.types, unitPrice])

  // Group by type for multiple scatter series
  const groupedByType = useMemo(() => {
    const groups = {}
    chartData.points?.forEach(p => {
      if (!groups[p.type]) groups[p.type] = []
      groups[p.type].push(p)
    })
    return groups
  }, [chartData.points])

  if (!properties.length) {
    return (
      <div className="chart-empty">
        <p>No transactions found for this period.</p>
        <p style={{ fontSize: 11, color: '#555', marginTop: 4 }}>
          Try adjusting filters or selecting a different time period.
        </p>
      </div>
    )
  }

  const trendInfo = {}
  Object.entries(chartData.trends || {}).forEach(([type, t]) => {
    trendInfo[type] = describeTrend(t, filters.months)
  })

  const yTickFormatter = unitPrice
    ? (v) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
    : (v) => `$${+(v / 1000000).toFixed(2)}M`

  return (
    <div className="chart-wrapper">
      <div className="chart-mode-toggle">
        <button
          className={`chart-mode-btn ${!unitPrice ? 'active' : ''}`}
          onClick={() => setUnitPrice(false)}
        >
          Total Price
        </button>
        <button
          className={`chart-mode-btn ${unitPrice ? 'active' : ''}`}
          onClick={() => setUnitPrice(true)}
        >
          $/m²
        </button>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart margin={{ top: 8, right: 12, bottom: 20, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2235" vertical={false} />

          <XAxis
            type="number"
            dataKey="x"
            domain={['auto', 'auto']}
            ticks={chartData.ticks}
            tickFormatter={chartData.dateFormatter}
            tick={{ fill: '#555', fontSize: 11 }}
            axisLine={{ stroke: '#2e3350' }}
            tickLine={false}
            label={{ value: '', position: 'insideBottom' }}
          />

          <YAxis
            type="number"
            dataKey="y"
            tickFormatter={yTickFormatter}
            domain={chartData.yMax != null ? [0, chartData.yMax] : [0, 'auto']}
            ticks={chartData.yTicks ?? undefined}
            allowDataOverflow
            tick={{ fill: '#555', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={52}
          />

          <Tooltip content={<CustomTooltip unitPrice={unitPrice} />} />

          {/* Scatter points per type */}
          {filters.types.map(type => {
            const pts = groupedByType[type] || []
            return pts.length > 0 ? (
              <Scatter
                key={type}
                name={type}
                data={pts.map(p => ({
                  ...p,
                  x: p.xNum,
                  y: unitPrice ? p.pricePerSqm : p.price,
                })).filter(p => p.y != null)}
                fill={TYPE_COLORS[type] || '#4f6ef7'}
                shape={<CustomDot fill={TYPE_COLORS[type] || '#4f6ef7'} />}
              />
            ) : null
          })}

          {/* Trend per type: P25–P75 band, then the median line on top */}
          {filters.types.map(type => {
            const curve = chartData.trends?.[type]?.curve
            if (!curve) return null
            return (
              <Area
                key={`band-${type}`}
                data={curve}
                dataKey="band"
                type="monotone"
                stroke="none"
                fill={TYPE_COLORS[type] || '#4f6ef7'}
                fillOpacity={0.18}
                activeDot={false}
                isAnimationActive={false}
              />
            )
          })}
          {filters.types.map(type => {
            const curve = chartData.trends?.[type]?.curve
            if (!curve) return null
            return (
              <Line
                key={`trend-${type}`}
                data={curve}
                dataKey="y"
                dot={false}
                activeDot={false}
                stroke={TYPE_COLORS[type] || '#4f6ef7'}
                strokeWidth={2.5}
                type="monotone"
                isAnimationActive={false}
              />
            )
          })}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="chart-legend">
        {filters.types.map(type => {
          const count = groupedByType[type]?.length || 0
          return count > 0 ? (
            <div key={type} className="chart-legend-item">
              <span
                className="chart-legend-dot"
                style={{ background: TYPE_COLORS[type] }}
              />
              <span>{type}</span>
              <span className="chart-legend-count">{count}</span>
              {trendInfo[type] && (
                <span className="chart-legend-trend" title={trendInfo[type].detail}>
                  {trendInfo[type].text}
                </span>
              )}
            </div>
          ) : null
        })}
        <div className="chart-legend-item trend-hint">
          <span className="chart-legend-line" style={{ background: '#9aa0b8' }} />
          <span style={{ color: '#555' }}>Median trend · band = middle 50%</span>
        </div>
        {chartData.clippedCount > 0 && (
          <div className="chart-legend-item" title="The y-axis is capped near the top of the typical price range so the trends stay readable.">
            <span style={{ color: '#555' }}>
              {chartData.clippedCount} sale{chartData.clippedCount !== 1 ? 's' : ''} above chart
            </span>
          </div>
        )}
        {chartData.trimmedCount > 0 && (
          <div className="chart-legend-item" title="Points beyond 3×IQR of their own type's quartiles are hidden so the trend stays readable. Panel stats above still include them.">
            <span style={{ color: '#555' }}>
              {chartData.trimmedCount} outlier{chartData.trimmedCount !== 1 ? 's' : ''} hidden (beyond 3×IQR per type)
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
