import React from 'react'
import './FilterBar.css'

const PROPERTY_TYPES = ['House', 'Unit', 'Townhouse', 'Land']

const TYPE_COLORS = {
  House: '#4f6ef7',
  Unit: '#34d399',
  Townhouse: '#fbbf24',
  Land: '#a78bfa',
}

const MONTH_OPTIONS = [
  { value: 1, label: '1 month' },
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
  { value: 24, label: '2 years' },
]

const PRICE_RANGES = [
  { label: 'Any', min: 0, max: Infinity },
  { label: '< $500k', min: 0, max: 500000 },
  { label: '$500k–$1M', min: 500000, max: 1000000 },
  { label: '$1M–$2M', min: 1000000, max: 2000000 },
  { label: '$2M–$5M', min: 2000000, max: 5000000 },
  { label: '> $5M', min: 5000000, max: Infinity },
]

export default function FilterBar({ filters, onFilterChange }) {
  const toggleType = (type) => {
    const newTypes = filters.types.includes(type)
      ? filters.types.filter(t => t !== type)
      : [...filters.types, type]
    if (newTypes.length > 0) {
      onFilterChange({ types: newTypes })
    }
  }

  const handlePriceRange = (range) => {
    onFilterChange({ minPrice: range.min, maxPrice: range.max })
  }

  const handleMonths = (e) => {
    onFilterChange({ months: Number(e.target.value) })
  }

  const currentPriceLabel = PRICE_RANGES.find(
    r => r.min === filters.minPrice && r.max === filters.maxPrice
  )?.label || 'Any'

  return (
    <div className="filter-bar">
      {/* Property type toggles */}
      <div className="filter-group">
        <span className="filter-label">Type</span>
        <div className="type-buttons">
          {PROPERTY_TYPES.map(type => (
            <button
              key={type}
              className={`type-btn ${filters.types.includes(type) ? 'active' : ''}`}
              style={{
                '--type-color': TYPE_COLORS[type],
              }}
              onClick={() => toggleType(type)}
              title={`Toggle ${type}`}
            >
              <span className="type-dot" />
              {type}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-divider" />

      {/* Time period */}
      <div className="filter-group">
        <span className="filter-label">Period</span>
        <select
          className="filter-select"
          value={filters.months}
          onChange={handleMonths}
        >
          {MONTH_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="filter-divider" />

      {/* Price range */}
      <div className="filter-group">
        <span className="filter-label">Price</span>
        <div className="price-buttons">
          {PRICE_RANGES.map(range => (
            <button
              key={range.label}
              className={`price-btn ${currentPriceLabel === range.label ? 'active' : ''}`}
              onClick={() => handlePriceRange(range)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
