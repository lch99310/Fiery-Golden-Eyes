import React, { useEffect, useRef, useMemo } from 'react'
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet'
import L from 'leaflet'
import { formatPrice } from '../utils/formatters'
import 'leaflet/dist/leaflet.css'
import './MapView.css'

// Fix Leaflet default icon issue with Vite
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// Color scale: green (low) → yellow → red (high)
function priceToColor(price, min, max) {
  if (!price || min === max) return '#4f6ef7'
  const ratio = Math.min(1, Math.max(0, (price - min) / (max - min)))
  if (ratio < 0.5) {
    // green → yellow
    const r = Math.round(52 + (251 - 52) * ratio * 2)
    const g = Math.round(211 + (191 - 211) * ratio * 2)
    const b = Math.round(153 + (36 - 153) * ratio * 2)
    return `rgb(${r},${g},${b})`
  } else {
    // yellow → red
    const t = (ratio - 0.5) * 2
    const r = Math.round(251 + (248 - 251) * t)
    const g = Math.round(191 + (113 - 191) * t)
    const b = Math.round(36 + (113 - 36) * t)
    return `rgb(${r},${g},${b})`
  }
}

// Component to recenter map
function MapController({ selectedSuburb, suburbCentroids }) {
  const map = useMap()
  useEffect(() => {
    if (selectedSuburb && suburbCentroids[selectedSuburb]) {
      const [lat, lng] = suburbCentroids[selectedSuburb]
      map.setView([lat, lng], Math.max(map.getZoom(), 14), { animate: true })
    }
  }, [selectedSuburb, suburbCentroids, map])
  return null
}

export default function MapView({ properties, suburbs, filters, selectedSuburb, onSuburbSelect }) {
  const geoJsonRef = useRef(null)

  // Compute median price per suburb from filtered properties
  const suburbStats = useMemo(() => {
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - filters.months)
    const stats = {}

    properties.forEach(p => {
      if (!filters.types.includes(p.type)) return
      if (new Date(p.date) < cutoff) return
      if (p.price < filters.minPrice || p.price > filters.maxPrice) return

      const sub = p.suburb.toUpperCase()
      if (!stats[sub]) stats[sub] = { prices: [], count: 0 }
      stats[sub].prices.push(p.price)
      stats[sub].count++
    })

    Object.keys(stats).forEach(sub => {
      const sorted = [...stats[sub].prices].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      stats[sub].median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
    })

    return stats
  }, [properties, filters])

  // Extract suburb centroids from GeoJSON for map controller
  const suburbCentroids = useMemo(() => {
    const centroids = {}
    if (!suburbs?.features) return centroids
    suburbs.features.forEach(f => {
      const name = (f.properties?.LOC_NAME || f.properties?.suburb || '').toUpperCase()
      if (!name) return
      try {
        // Use centroid approximation from bbox
        const coords = f.geometry?.coordinates
        if (!coords) return
        // Flatten all coordinates to find center
        const allCoords = []
        const flatten = (arr) => {
          if (typeof arr[0] === 'number') allCoords.push(arr)
          else arr.forEach(flatten)
        }
        flatten(coords)
        if (!allCoords.length) return
        const lngs = allCoords.map(c => c[0])
        const lats = allCoords.map(c => c[1])
        centroids[name] = [
          (Math.min(...lats) + Math.max(...lats)) / 2,
          (Math.min(...lngs) + Math.max(...lngs)) / 2,
        ]
      } catch {
        // skip bad geometry
      }
    })
    return centroids
  }, [suburbs])

  // Price range for color scale
  const { minPrice, maxPrice } = useMemo(() => {
    const medians = Object.values(suburbStats).map(s => s.median).filter(Boolean)
    if (!medians.length) return { minPrice: 500000, maxPrice: 5000000 }
    return { minPrice: Math.min(...medians), maxPrice: Math.max(...medians) }
  }, [suburbStats])

  // Style each suburb polygon
  const suburbStyle = (feature) => {
    const name = (feature.properties?.LOC_NAME || feature.properties?.suburb || '').toUpperCase()
    const stats = suburbStats[name]
    const isSelected = name === selectedSuburb?.toUpperCase()

    return {
      fillColor: stats ? priceToColor(stats.median, minPrice, maxPrice) : '#2e3350',
      fillOpacity: isSelected ? 0.85 : stats ? 0.6 : 0.2,
      color: isSelected ? '#fff' : stats ? 'rgba(255,255,255,0.3)' : '#2e3350',
      weight: isSelected ? 2.5 : 1,
    }
  }

  // Attach event handlers to each suburb feature
  function onEachSuburb(feature, layer) {
    const name = (feature.properties?.LOC_NAME || feature.properties?.suburb || '').toUpperCase()
    const stats = suburbStats[name]

    const tooltipContent = stats
      ? `<div class="map-tooltip">
          <strong>${name}</strong>
          <div>Median: ${formatPrice(stats.median)}</div>
          <div>${stats.count} sale${stats.count !== 1 ? 's' : ''}</div>
         </div>`
      : `<div class="map-tooltip"><strong>${name}</strong><div>No data</div></div>`

    layer.bindTooltip(tooltipContent, {
      sticky: true,
      className: 'custom-tooltip',
      offset: [10, 0],
    })

    layer.on({
      mouseover(e) {
        const l = e.target
        if (name !== selectedSuburb?.toUpperCase()) {
          l.setStyle({ fillOpacity: 0.8, weight: 1.5, color: 'rgba(255,255,255,0.6)' })
        }
        l.bringToFront()
      },
      mouseout(e) {
        geoJsonRef.current?.resetStyle(e.target)
      },
      click() {
        if (stats) {
          onSuburbSelect(name)
        }
      },
    })
  }

  // Legend labels
  const legendItems = [
    { color: priceToColor(minPrice, minPrice, maxPrice), label: formatPrice(minPrice) },
    { color: priceToColor((minPrice + maxPrice) / 2, minPrice, maxPrice), label: formatPrice((minPrice + maxPrice) / 2) },
    { color: priceToColor(maxPrice, minPrice, maxPrice), label: formatPrice(maxPrice) },
  ]

  return (
    <div className="map-container">
      <MapContainer
        center={[-33.865, 151.209]}
        zoom={11}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        {/* Dark tile layer */}
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          subdomains="abcd"
          maxZoom={19}
        />

        {/* Suburb boundaries */}
        {suburbs?.features?.length > 0 && (
          <GeoJSON
            key={`${selectedSuburb}-${JSON.stringify(filters)}`}
            ref={geoJsonRef}
            data={suburbs}
            style={suburbStyle}
            onEachFeature={onEachSuburb}
          />
        )}

        <MapController selectedSuburb={selectedSuburb} suburbCentroids={suburbCentroids} />
      </MapContainer>

      {/* Color legend */}
      <div className="map-legend">
        <div className="legend-title">Median Price</div>
        <div className="legend-gradient">
          <div
            className="legend-bar"
            style={{
              background: `linear-gradient(to right, ${legendItems.map(i => i.color).join(', ')})`,
            }}
          />
          <div className="legend-labels">
            {legendItems.map((item, i) => (
              <span key={i} style={{ color: item.color }}>{item.label}</span>
            ))}
          </div>
        </div>
        <div className="legend-hint">Click a suburb to view details</div>
      </div>

      {/* Transaction count badge */}
      <div className="map-stats-badge">
        <span className="badge-number">{Object.values(suburbStats).reduce((s, v) => s + v.count, 0).toLocaleString()}</span>
        <span className="badge-label">transactions</span>
        <span className="badge-sep">·</span>
        <span className="badge-number">{Object.keys(suburbStats).length}</span>
        <span className="badge-label">suburbs</span>
      </div>
    </div>
  )
}
