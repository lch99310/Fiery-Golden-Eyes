import React, { useState, useCallback } from 'react'
import MapView, { streetOf } from './components/MapView'
import FilterBar from './components/FilterBar'
import SuburbPanel from './components/SuburbPanel'
import { usePropertyData } from './hooks/usePropertyData'
import './App.css'

export default function App() {
  const [selectedSuburb, setSelectedSuburb] = useState(null)
  const [selectedStreet, setSelectedStreet] = useState(null)
  const [filters, setFilters] = useState({
    types: ['House', 'Unit', 'Townhouse', 'Land', 'Commercial'],
    minPrice: 0,
    maxPrice: Infinity,
    months: 12,
  })

  const { properties, suburbs, lastUpdated, dataNote, loading, error } = usePropertyData()

  const handleSuburbSelect = useCallback((suburb, street = null) => {
    setSelectedSuburb(suburb)
    setSelectedStreet(street)
  }, [])

  const handleFilterChange = useCallback((newFilters) => {
    setFilters(f => ({ ...f, ...newFilters }))
  }, [])

  const handleClosePanel = useCallback(() => {
    setSelectedSuburb(null)
    setSelectedStreet(null)
  }, [])

  // Filter properties for selected suburb
  const suburbProperties = React.useMemo(() => {
    if (!selectedSuburb || !properties.length) return []
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - filters.months)
    const cutoffTs = cutoff.getTime()
    const target = selectedSuburb.toUpperCase()

    return properties.filter(p => {
      const matchSuburb = p.suburb.toUpperCase() === target
      const matchStreet = !selectedStreet || streetOf(p.address) === selectedStreet
      const matchType = filters.types.includes(p.type)
      const matchPrice = p.price >= filters.minPrice && p.price <= filters.maxPrice
      const matchDate = p._ts >= cutoffTs
      return matchSuburb && matchStreet && matchType && matchPrice && matchDate
    })
  }, [selectedSuburb, selectedStreet, properties, filters])

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <img src="./favicon.png" alt="logo" className="header-logo-img" width="28" height="28" />
          <h1 className="header-title">Fiery-Golden-Eyes</h1>
          <span className="header-subtitle">Sydney House Price</span>
        </div>
        <div className="header-right">
          {lastUpdated && (
            <span className="last-updated">
              Updated: {lastUpdated}
            </span>
          )}
          <a
            href="https://www.valuergeneral.nsw.gov.au/"
            target="_blank"
            rel="noopener noreferrer"
            className="data-source-link"
          >
            Source: NSW Valuer General
          </a>
        </div>
      </header>

      {/* Filter Bar */}
      <FilterBar filters={filters} onFilterChange={handleFilterChange} />

      {/* Main content */}
      <div className="app-body">
        {loading && (
          <div className="loading-overlay">
            <div className="loading-spinner" />
            <p>Loading property data…</p>
          </div>
        )}
        {error && (
          <div className="error-banner">
            ⚠️ {error}
          </div>
        )}
        {!loading && !error && properties.length === 0 && (
          <div className="empty-banner">
            No property data published yet — awaiting the first upload of real
            NSW Valuer General sales data. Placeholder data has been removed
            so that only genuine figures are ever shown.
          </div>
        )}

        {/* Map */}
        <div className={`map-wrapper ${selectedSuburb ? 'with-panel' : ''}`}>
          <MapView
            properties={properties}
            suburbs={suburbs}
            filters={filters}
            selectedSuburb={selectedSuburb}
            onSuburbSelect={handleSuburbSelect}
          />
        </div>

        {/* Sidebar Panel */}
        {selectedSuburb && (
          <SuburbPanel
            suburb={selectedSuburb}
            street={selectedStreet}
            properties={suburbProperties}
            filters={filters}
            onClose={handleClosePanel}
            onClearStreet={() => setSelectedStreet(null)}
            onFilterChange={handleFilterChange}
          />
        )}
      </div>

      {/* Data disclaimer footer */}
      <div className={`data-disclaimer ${dataNote ? 'data-disclaimer--warning' : ''}`}>
        <span className="disclaimer-icon">{dataNote ? '⚠️' : 'ⓘ'}</span>
        <span>
          {dataNote ? (
            <><strong>{dataNote}</strong> Prices and addresses shown are NOT real sales.</>
          ) : (
            <>
              Official data from <strong>NSW Valuer General PSI</strong> (weekly updates).
              Property positions are approximate (suburb centroid). Bedroom/bathroom counts not available from VG data.
              Verify details via <a href="https://valuation.property.nsw.gov.au/embed/propertySalesInformation" target="_blank" rel="noopener noreferrer">official NSW VG sales enquiry</a>.
            </>
          )}
        </span>
      </div>
    </div>
  )
}
