import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, GeoJSON, Pane,} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const DATA_PATHS = {
  severity: "/data/severity_model.geojson",
  stability: "/data/stability.geojson",
  stores: "/data/stores.geojson",
  tracts: "/data/tracts.geojson",
  walkIso: "/data/walk_iso.geojson",
  driveIso: "/data/drive_iso.geojson",
  edges: "/data/edges.geojson",
};

const GREEN_YELLOW_RED_9 = [
  { min: 0.0, max: 0.1, label: "0.0 – 0.1", color: "#1a9641" },
  { min: 0.1, max: 0.2, label: "0.1 – 0.2", color: "#60b856" },
  { min: 0.2, max: 0.3, label: "0.2 – 0.3", color: "#a6d96a" },
  { min: 0.3, max: 0.4, label: "0.3 – 0.4", color: "#d3ec95" },
  { min: 0.4, max: 0.5, label: "0.4 – 0.5", color: "#ffffc0" },
  { min: 0.5, max: 0.6, label: "0.5 – 0.6", color: "#fed791" },
  { min: 0.6, max: 0.7, label: "0.6 – 0.7", color: "#fdae61" },
  { min: 0.7, max: 0.8, label: "0.7 – 0.8", color: "#ea643f" },
  { min: 0.8, max: Infinity, label: "0.8+", color: "#d7191c" },
];

const GREEN_YELLOW_RED_5 = {
  1: "#1a9641" ,
  2: "#a6d96a" ,
  3: "#ffffc0" ,
  4: "#fdae61" ,
  5: "#d7191c" ,
};

const BASE_SEVERITY_RANGES = [
  { min: 0, max: 0.099583922728383, label: "0 – 0.10", color: "#1a9641" },
  { min: 0.099583922728383, max: 0.161404004458808, label: "0.10 – 0.16", color: "#77c35c" },
  { min: 0.161404004458808, max: 0.199877236033354, label: "0.16 – 0.20", color: "#c4e687" },
  { min: 0.199877236033354, max: 0.261146547356538, label: "0.20 – 0.26", color: "#ffffc0" },
  { min: 0.261146547356538, max: 0.290543618335021, label: "0.26 – 0.29", color: "#fed791" },
  { min: 0.290543618335021, max: 0.355829782775969, label: "0.29 – 0.36", color: "#fdae61" },
  { min: 0.355829782775969, max: Infinity, label: "0.36+", color: "#d7191c" },
];

const CLASSIFICATION_COLORS = {
  "Extreme": "#d7191c",
  "Very High": "#ea643f",
  "High": "#fdae61",
  "Moderate": "#ffffc0",
  "Low": "#a6d96a",
  "Very Low": "#60b856",
  "Minimal": "#1a9641",
};

const STABILITY_COLORS = {
  "Not High": "#f1eef6",
  "Access Driven": "#ff4100",
  "Demographic Driven": "#0041ff",
  "Stable High (All Models)": "#ff41ff",
};

const MODEL_OPTIONS = {
  baseMapOnly: {
    label: "Base Map Only",
    field: null,
    type: "transparent",
    dataSource: "severity",
    description: "View the underlying basemap without the main block group overlay.",
  },
  baseSeverity: {
    label: "Food Desert Severity",
    field: "food_desert_severity",
    type: "range",
    ranges: BASE_SEVERITY_RANGES,
    dataSource: "severity",
    description: "Base quantile-style severity model derived from food accessibility projections.",
  },
  accessHeavy: {
    label: "Access-Heavy Severity",
    field: "severity_access_heavy",
    type: "range",
    ranges: GREEN_YELLOW_RED_9,
    dataSource: "severity",
    description: "Severity model weighted more heavily toward network accessibility.",
  },
  demoHeavy: {
    label: "Demographic-Heavy Severity",
    field: "severity_demo_heavy",
    type: "range",
    ranges: GREEN_YELLOW_RED_9,
    dataSource: "severity",
    description: "Severity model weighted more heavily toward demographic vulnerability.",
  },
  stability: {
    label: "Stability Class",
    field: "stability_class",
    type: "category",
    colors: STABILITY_COLORS,
    dataSource: "stability",
    description: "Sensitivity result: whether high-severity areas are access-driven, demographic-driven, or stable across models.",
  },
    severityClassification: {
    label: "Severity Classification",
    field: "severity_classification",
    type: "category",
    colors: CLASSIFICATION_COLORS,
    dataSource: "severity",
    description: "Threshold-based lack of access classification with demographic and mobility projections. Sorted from Minimal through Extreme.",
  },
};

function formatNumber(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(decimals);
}

function formatInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return Math.round(n).toLocaleString();
}

function formatPercent(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }

  return `${(Number(value) * 100).toFixed(decimals)}%`;
}

function colorFromRanges(value, ranges) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "#cccccc";

  const match = ranges.find((range) => n >= range.min && n < range.max);
  return match ? match.color : "#cccccc";
}

function colorFromCategory(value, colors) {
  if (value === null || value === undefined) return "#cccccc";
  return colors[String(value)] || "#cccccc";
}

function getFeatureColor(feature, activeModel) {
  const model = MODEL_OPTIONS[activeModel];
  const value = feature.properties?.[model.field];

  if (model.type === "range") {
    return colorFromRanges(value, model.ranges);
  }

  return colorFromCategory(value, model.colors);
}

function mainLayerStyle(activeModel) {
  return function (feature) {
    const model = MODEL_OPTIONS[activeModel];

    if (model?.type === "transparent") {
      return {
        fillColor: "transparent",
        color: "transparent",
        weight: 0,
        opacity: 0,
        fillOpacity: 0,
      };
    }

    const isStability = activeModel === "stability";

    return {
      fillColor: getFeatureColor(feature, activeModel),
      color: isStability ? "#ffffff" : "#f8f8f8",
      weight: isStability ? 0.6 : 0.4,
      opacity: 1,
      fillOpacity: isStability ? 1 : 0.78,
    };
  };
}

function tractStyle() {
  return {
    fillColor: "#e6e6e6",
    fillOpacity: 0.08,
    color: "#232323",
    weight: 0.6,
    opacity: 0.7,
  };
}

function walkIsoStyle() {
  return {
    fillColor: "#53bcd5",
    color: "#57a9e3",
    weight: 0.8,
    opacity: 0.9,
    fillOpacity: 0.32,
  };
}

function driveIsoStyle() {
  return {
    fillColor: "#a560ed",
    color: "#b57fc9",
    weight: 0.1,
    opacity: 0.25,
    fillOpacity: 0.01,
  };
}

function edgeStyle() {
  return {
    color: "#e5c368",
    weight: 0.8,
    opacity: 0.45,
  };
}

function popupRow(label, value, active = false) {
  return `
    <div style="
      padding: ${active ? "6px 8px" : "2px 0"};
      margin: ${active ? "4px 0" : "0"};
      background: ${active ? "#e0f2fe" : "transparent"};
      border-left: ${active ? "4px solid #2563eb" : "none"};
      font-weight: ${active ? "700" : "400"};
    ">
      <strong>${label}:</strong> ${value}
    </div>
  `;
}

function bindMainPopup(feature, layer, activeModel) {
  const p = feature.properties || {};
  const option = MODEL_OPTIONS[activeModel];
  const selectedField = option.field;

  layer.bindPopup(`
    <div style="font-family: Arial, sans-serif; min-width: 240px;">
      <h3 style="margin: 0 0 8px 0;">
        Block Group ${p.block_group_number ?? "N/A"}
      </h3>

      ${popupRow(
        "Base Severity",
        formatNumber(p.food_desert_severity),
        selectedField === "food_desert_severity"
      )}

      ${popupRow(
        "Access-Heavy Severity",
        formatNumber(p.severity_access_heavy),
        selectedField === "severity_access_heavy"
      )}

      ${popupRow(
        "Demographic-Heavy Severity",
        formatNumber(p.severity_demo_heavy),
        selectedField === "severity_demo_heavy"
      )}

      ${popupRow(
        "Access Score",
        formatNumber(p.access_score),
        selectedField === "access_score"
      )}

      ${popupRow(
        "Stability Class",
        p.stability_class ?? "N/A",
        selectedField === "stability_class"
      )}

      ${popupRow(
        "Severity Classification",
        p.severity_classification ?? "N/A",
        selectedField === "severity_classification"
      )}

      <hr/>

      <strong>Allocated Population:</strong> ${formatInteger(p.allocated_population)}<br/>
      <strong>Walk Time:</strong> ${formatNumber(p.walk_time_min, 1)} min<br/>
      <strong>Drive Time:</strong> ${formatNumber(p.drive_time_min, 1)} min<br/>
      <strong>Poverty Index:</strong> ${formatPercent(p.norm_poverty)}<br/>
      <strong>No-Vehicle Index:</strong> ${formatPercent(p.norm_no_vehicle)}<br/>
      <strong>Block Group Area:</strong> ${formatNumber(p.bg_area_sq_mi ?? p.bg_area, 3)} sq mi
    </div>
  `);
}

function bindStabilityPopup(feature, layer) {
  const p = feature.properties || {};

  layer.bindPopup(`
    <div style="font-family: Arial, sans-serif; min-width: 210px;">
      <h3 style="margin: 0 0 8px 0;">Stability Analysis</h3>
      <strong>Stability Class:</strong> ${p.stability_class ?? "N/A"}<br/>
      <strong>High Base:</strong> ${p.high_base ?? "N/A"}<br/>
      <strong>High Access:</strong> ${p.high_access ?? "N/A"}<br/>
      <strong>High Demo:</strong> ${p.high_demo ?? "N/A"}
    </div>
  `);
}

function bindTractPopup(feature, layer) {
  const p = feature.properties || {};
  layer.bindPopup(`
    <div style="font-family: Arial, sans-serif; min-width: 180px;">
      <h3 style="margin: 0 0 8px 0;">Census Tract</h3>
      <strong>Total Population:</strong> ${formatInteger(p.total_population)}
    </div>
  `);
}

function bindStorePopup(feature, layer) {
  const p = feature.properties || {};
  const name = p.standardized_name || p.store_name || p.name || p.brand || "Grocery Store";

  layer.bindPopup(`
    <div style="font-family: Arial, sans-serif; min-width: 190px;">
      <h3 style="margin: 0 0 8px 0;">${name}</h3>
      <strong>Type:</strong> ${p.store_type ?? p.shop ?? "N/A"}<br/>
    </div>
  `);
}

function bindIsoPopup(feature, layer, label) {
  const p = feature.properties || {};
  layer.bindPopup(`
    <div style="font-family: Arial, sans-serif; min-width: 180px;">
      <h3 style="margin: 0 0 8px 0;">${label}</h3>
      <strong>Time:</strong> ${p.time ?? p.minutes ?? p.contour ?? "N/A"} minutes
    </div>
  `);
}

async function fetchGeoJson(path, required = false) {
  const response = await fetch(path);

  if (!response.ok) {
    if (required) throw new Error(`Required file failed to load: ${path}`);
    console.warn(`Optional file failed to load: ${path}`);
    return null;
  }

  return response.json();
}

function Legend({ activeModel }) {
  const model = MODEL_OPTIONS[activeModel];

  if (model.type === "transparent") {
  return (
    <div style={styles.legend}>
      <h3 style={styles.legendTitle}>{model.label}</h3>
      <div style={styles.legendRow}>
        <span style={{ ...styles.swatch, backgroundColor: "#ffffff" }} />
        <span>Main analytical overlay hidden</span>
      </div>
    </div>
  );
  }

  const rows = model.type === "range"
    ? model.ranges.map((range) => ({ label: range.label, color: range.color }))
    : Object.entries(model.colors).map(([label, color]) => ({ label, color }));

  return (
    <div style={styles.legend}>
      <h3 style={styles.legendTitle}>{model.label}</h3>
      {rows.map((row) => (
        <div key={row.label} style={styles.legendRow}>
          <span style={{ ...styles.swatch, backgroundColor: row.color }} />
          <span>{row.label}</span>
        </div>
      ))}
      <div style={styles.legendRow}>
        <span style={{ ...styles.swatch, backgroundColor: "#cccccc" }} />
        <span>Missing / Other</span>
      </div>
    </div>
  );
}

export default function App() {

  const [activeModel, setActiveModel] = useState("baseSeverity");
  const [panelOpen, setPanelOpen] = useState(true);

  const [severityData, setSeverityData] = useState(null);
  const [stabilityData, setStabilityData] = useState(null);
  const [storesData, setStoresData] = useState(null);
  const [tractsData, setTractsData] = useState(null);
  const [walkIsoData, setWalkIsoData] = useState(null);
  const [driveIsoData, setDriveIsoData] = useState(null);
  const [edgesData, setEdgesData] = useState(null);

  const [showStores, setShowStores] = useState(false);
  const [showTracts, setShowTracts] = useState(false);
  const [showWalkIso, setShowWalkIso] = useState(false);
  const [showDriveIso, setShowDriveIso] = useState(false);
  const [showEdges, setShowEdges] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadRequiredData() {
      try {
        const [severity, stability, stores] = await Promise.all([
          fetchGeoJson(DATA_PATHS.severity, true),
          fetchGeoJson(DATA_PATHS.stability, false),
          fetchGeoJson(DATA_PATHS.stores, false),
        ]);

        setSeverityData(severity);
        setStabilityData(stability);
        setStoresData(stores);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadRequiredData();
  }, []);

  useEffect(() => {
    if (showTracts && !tractsData) fetchGeoJson(DATA_PATHS.tracts).then(setTractsData);
  }, [showTracts, tractsData]);

  useEffect(() => {
    if (showWalkIso && !walkIsoData) fetchGeoJson(DATA_PATHS.walkIso).then(setWalkIsoData);
  }, [showWalkIso, walkIsoData]);

  useEffect(() => {
    if (showDriveIso && !driveIsoData) fetchGeoJson(DATA_PATHS.driveIso).then(setDriveIsoData);
  }, [showDriveIso, driveIsoData]);

  useEffect(() => {
    if (showEdges && !edgesData) fetchGeoJson(DATA_PATHS.edges).then(setEdgesData);
  }, [showEdges, edgesData]);

  const activeData = useMemo(() => {
    return MODEL_OPTIONS[activeModel].dataSource === "stability" && stabilityData
      ? stabilityData
      : severityData;
  }, [activeModel, severityData, stabilityData]);

  if (loading) {
    return <div style={styles.centered}><h1>Loading GIS data...</h1></div>;
  }

  if (error) {
    return (
      <div style={styles.centered}>
        <h1>Data failed to load</h1>
        <p>{error}</p>
        <p>Check your files in <code>frontend/public/data/</code>.</p>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      {!panelOpen && (
        <button
          type="button"
          style={styles.panelButton}
          onClick={() => setPanelOpen(true)}
          aria-label="Open side panel"
        >
          ☰ Panel
        </button>
      )}

      <aside
        style={{
          ...styles.sidebar,
          ...(panelOpen ? styles.sidebarOpen : styles.sidebarClosed),
        }}
      >
        <div style={styles.sidebarHeader}>
          <div>
            <h1 style={styles.title}> S A F E </h1>
            <h3 style={styles.subtitle}>The Spatial Accessibility to Food Explorer</h3>
          </div>

          <button
            type="button"
            style={styles.closeButton}
            onClick={() => setPanelOpen(false)}
            aria-label="Close side panel"
          >
            ×
          </button>
        </div>

        <p style={styles.subtitle}>Interactive food access severity model for the St. Louis, Missouri region.</p>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Map Field</h2>
          {Object.entries(MODEL_OPTIONS).map(([key, model]) => (
            <button
              key={key}
              onClick={() => setActiveModel(key)}
              style={{
                ...styles.button,
                ...(activeModel === key ? styles.activeButton : {}),
              }}
            >
              {model.label}
            </button>
          ))}
          <p style={styles.description}>{MODEL_OPTIONS[activeModel].description}</p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Optional Layers</h2>
          <Checkbox label="Stores" checked={showStores} onChange={setShowStores} />
          <Checkbox label="Walk isochrones" checked={showWalkIso} onChange={setShowWalkIso} />
          <Checkbox label="Drive isochrones" checked={showDriveIso} onChange={setShowDriveIso} />
          <Checkbox label="Network edges (Intensive)" checked={showEdges} onChange={setShowEdges} />
        </section>
      </aside>

  <main style={styles.mapPanel}>
    <MapContainer
      center={[38.66, -90.35]}
      zoom={10}
      minZoom={8}
      style={styles.map}
      preferCanvas={false}
    >
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* MAIN BLOCK GROUP LAYER — clickable */}
      <Pane name="main-pane" style={{ zIndex: 400 }}>
        {activeData && (
          <GeoJSON
            key={`main-${activeModel}`}
            data={activeData}
            pane="main-pane"
            interactive={true}
            style={mainLayerStyle(activeModel)}
            onEachFeature={(feature, layer) => {
              if (MODEL_OPTIONS[activeModel].dataSource === "stability") {
                bindStabilityPopup(feature, layer);
              } else {
                bindMainPopup(feature, layer, activeModel);
              }

              layer.on({
                mouseover: (e) => {
                  e.target.setStyle({
                    weight: 2,
                    color: "#111111",
                    fillOpacity: 0.85,
                  });
                  e.target.bringToFront();
                },
                mouseout: (e) => {
                  e.target.setStyle(mainLayerStyle(activeModel)(feature));
                },
              });
            }}
          />
        )}
      </Pane>

      {/* TRACTS — visual only, non-clickable */}
      <Pane name="tract-pane" style={{ zIndex: 450 }}>
        {showTracts && tractsData && (
          <GeoJSON
            key="tracts"
            data={tractsData}
            pane="tract-pane"
            interactive={false}
            style={tractStyle}
          />
        )}
      </Pane>

      {/* ISOCHRONES — visual only, non-clickable */}
      <Pane name="isochrone-pane" style={{ zIndex: 460 }}>
        {showWalkIso && walkIsoData && (
          <GeoJSON
            key="walk-iso"
            data={walkIsoData}
            pane="isochrone-pane"
            interactive={false}
            style={walkIsoStyle}
          />
        )}

        {showDriveIso && driveIsoData && (
          <GeoJSON
            key="drive-iso"
            data={driveIsoData}
            pane="isochrone-pane"
            interactive={false}
            style={driveIsoStyle}
          />
        )}
      </Pane>

      {/* NETWORK EDGES — visual only, non-clickable */}
      <Pane name="edge-pane" style={{ zIndex: 470 }}>
        {showEdges && edgesData && (
          <GeoJSON
            key="edges"
            data={edgesData}
            pane="edge-pane"
            interactive={false}
            style={edgeStyle}
          />
        )}
      </Pane>

      {/* STORES — clickable and visually on top */}
      <Pane name="store-pane" style={{ zIndex: 650 }}>
        {showStores && storesData && (
          <GeoJSON
            key="stores"
            data={storesData}
            pane="store-pane"
            interactive={true}
            pointToLayer={(feature, latlng) =>
              L.circleMarker(latlng, {
                pane: "store-pane",
                radius: 6,
                color: "#111111",
                weight: 1,
                fillColor: "#00f250",
                fillOpacity: 1,
                interactive: true,
              })
            }
            onEachFeature={bindStorePopup}
          />
        )}
      </Pane>

    </MapContainer>
    <Legend activeModel={activeModel} />
  </main>
    </div>
  );
}

function Checkbox({ label, checked, onChange }) {
  return (
    <label style={styles.checkboxLabel}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

const styles = {
  app: {
    height: "100vh",
    width: "100%",
    position: "relative",
    overflow: "hidden",
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  sidebar: {
    position: "fixed",
    top: 0,
    left: 0,
    width: "min(340px, 92vw)",
    height: "100vh",
    background: "#111827",
    color: "#f9fafb",
    padding: 22,
    overflowY: "auto",
    boxSizing: "border-box",
    boxShadow: "2px 0 16px rgba(0,0,0,0.35)",
    zIndex: 3000,
    transition: "transform 240ms ease",
  },
  sidebarOpen: {
    transform: "translateX(0)",
  },
  sidebarClosed: {
    transform: "translateX(-105%)",
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  closeButton: {
    flex: "0 0 auto",
    width: 36,
    height: 36,
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(255,255,255,0.06)",
    color: "#f9fafb",
    fontSize: "1.5rem",
    lineHeight: 1,
    cursor: "pointer",
  },
  panelButton: {
    position: "fixed",
    top: 14,
    left: 14,
    zIndex: 3500,
    border: "1px solid rgba(255,255,255,0.22)",
    borderRadius: 12,
    background: "rgba(17,24,39,0.96)",
    color: "#f9fafb",
    padding: "10px 13px",
    fontWeight: 700,
    boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    cursor: "pointer",
  },
  title: {
    margin: "0 0 8px 0",
    fontSize: "1.55rem",
    lineHeight: 1.2,
  },
  subtitle: {
    color: "#d1d5db",
    fontSize: "0.92rem",
    lineHeight: 1.45,
    marginBottom: 22,
  },
  section: {
    borderTop: "1px solid rgba(255,255,255,0.15)",
    paddingTop: 16,
    marginTop: 16,
  },
  sectionTitle: {
    margin: "0 0 10px 0",
    color: "#9ca3af",
    fontSize: "0.85rem",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  button: {
    width: "100%",
    display: "block",
    marginBottom: 8,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.05)",
    color: "#f9fafb",
    cursor: "pointer",
    textAlign: "left",
  },
  activeButton: {
    background: "#2563eb",
    borderColor: "#60a5fa",
  },
  description: {
    color: "#d1d5db",
    fontSize: "0.88rem",
    lineHeight: 1.45,
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
    fontSize: "0.92rem",
    cursor: "pointer",
  },
  mapPanel: {
    position: "relative",
    height: "100vh",
    width: "100%",
    zIndex: 1,
  },
  map: {
    height: "100%",
    width: "100%",
  },
  legend: {
    position: "absolute",
    right: 18,
    bottom: 24,
    zIndex: 500,
    background: "white",
    padding: "12px 14px",
    borderRadius: 10,
    boxShadow: "0 3px 12px rgba(0,0,0,0.25)",
    fontSize: "0.82rem",
    minWidth: 110,
    maxWidth: 190,
    maxHeight: "45vh",
    overflowY: "auto",
  },
  legendTitle: {
    margin: "0 0 8px 0",
    fontSize: "0.92rem",
  },
  legendRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 5,
  },
  swatch: {
    display: "inline-block",
    width: 18,
    height: 12,
    border: "1px solid rgba(0,0,0,0.25)",
  },
  centered: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "2rem",
    textAlign: "center",
  },
};
