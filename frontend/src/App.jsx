import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  Filter,
  Info,
  Layers,
  MapPinned,
  Menu,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { fetchParcel, fetchRankedParcels } from "./api";

const PROFILE_DEFS = {
  residential_homestead: {
    key: "residential_homestead",
    label: "Residential / Homestead",
    scoreField: "residential_homestead_score",
    classField: "residential_homestead_class",
    weights: {
      slope_score: 0.3,
      access_score: 0.2,
      proximity_score: 0.15,
      risk_score: 0.25,
      vegetation_score: 0.05,
      acreage_score: 0.05,
    },
  },
  agriculture_open_land: {
    key: "agriculture_open_land",
    label: "Agriculture / Open Land",
    scoreField: "agriculture_open_land_score",
    classField: "agriculture_open_land_class",
    weights: {
      slope_score: 0.25,
      vegetation_score: 0.25,
      acreage_score: 0.2,
      access_score: 0.15,
      risk_score: 0.15,
    },
  },
  event_venue_rural_tourism: {
    key: "event_venue_rural_tourism",
    label: "Event Venue / Rural Tourism",
    scoreField: "event_venue_rural_tourism_score",
    classField: "event_venue_rural_tourism_class",
    weights: {
      access_score: 0.25,
      proximity_score: 0.2,
      terrain_variety_score: 0.2,
      risk_score: 0.2,
      acreage_score: 0.1,
      vegetation_score: 0.05,
    },
  },
  conservation_habitat: {
    key: "conservation_habitat",
    label: "Conservation / Habitat",
    scoreField: "conservation_habitat_score",
    classField: "conservation_habitat_class",
    weights: {
      vegetation_score: 0.25,
      water_habitat_score: 0.25,
      wetland_habitat_score: 0.15,
      acreage_score: 0.15,
      low_access_score: 0.1,
      terrain_variety_score: 0.1,
    },
  },
};

const WEIGHT_META = {
  slope_score: ["Slope", "Rewards usable/gentle terrain."],
  access_score: ["Road Access", "Rewards parcels closer to roads."],
  low_access_score: ["Remoteness", "Rewards parcels farther from roads."],
  proximity_score: ["Town Proximity", "Rewards parcels closer to towns/service centers."],
  risk_score: ["Low Flood/Wetland Risk", "Rewards lower floodplain and wetland overlap."],
  vegetation_score: ["Vegetation", "Rewards stronger NDVI/vegetation value."],
  acreage_score: ["Acreage", "Rewards larger parcels up to the acreage cap."],
  water_habitat_score: ["Water Habitat", "Rewards streams and waterbody features."],
  wetland_habitat_score: ["Wetland Habitat", "Rewards wetland presence for conservation value."],
  terrain_variety_score: ["Terrain Variety", "Rewards mixed terrain useful for scenery/habitat."],
};

const PROFILE_OPTIONS = Object.values(PROFILE_DEFS);
const ALL_WEIGHT_FIELDS = Object.keys(WEIGHT_META);

const DEFAULT_FILTERS = {
  minScore: 50,
  maxFloodplainPct: 20,
  maxWetlandPct: 20,
  minAreaAcres: "",
  maxDistanceToRoadM: "",
  maxDistanceToTownKm: "",
  streamPresent: "any",
};

function fillAllWeights(profileWeights) {
  return Object.fromEntries(ALL_WEIGHT_FIELDS.map((field) => [field, Number(profileWeights?.[field] || 0)]));
}

function normalizeWeights(weights) {
  const clean = Object.fromEntries(ALL_WEIGHT_FIELDS.map((field) => [field, Math.max(0, Number(weights[field] || 0))]));
  const sum = Object.values(clean).reduce((a, b) => a + b, 0);
  if (!sum) return clean;
  return Object.fromEntries(Object.entries(clean).map(([field, value]) => [field, Number((value / sum).toFixed(4))]));
}

function presetFillExpression(scoreField) {
  return [
    "case",
    [">=", ["to-number", ["get", scoreField]], 80], "#166534",
    [">=", ["to-number", ["get", scoreField]], 65], "#22c55e",
    [">=", ["to-number", ["get", scoreField]], 50], "#facc15",
    [">=", ["to-number", ["get", scoreField]], 35], "#f97316",
    "#dc2626",
  ];
}

function customScoreExpression(weights) {
  const terms = Object.entries(weights)
    .filter(([, weight]) => Number(weight) > 0)
    .map(([field, weight]) => ["*", ["to-number", ["coalesce", ["get", field], 0]], Number(weight)]);
  if (!terms.length) return 0;
  if (terms.length === 1) return terms[0];
  return ["+", ...terms];
}

function customFillExpression(weights) {
  const score = customScoreExpression(weights);
  return [
    "case",
    [">=", score, 80], "#166534",
    [">=", score, 65], "#22c55e",
    [">=", score, 50], "#facc15",
    [">=", score, 35], "#f97316",
    "#dc2626",
  ];
}

function calculateCustomScore(parcel, weights) {
  if (!parcel) return null;
  const total = Object.entries(weights).reduce((sum, [field, weight]) => sum + Number(parcel[field] || 0) * Number(weight || 0), 0);
  return Math.max(0, Math.min(100, total));
}

function classFromScore(score) {
  const n = Number(score);
  if (Number.isNaN(n)) return "—";
  if (n >= 80) return "Very High";
  if (n >= 65) return "High";
  if (n >= 50) return "Moderate";
  if (n >= 35) return "Low";
  return "Very Low";
}

function formatNumber(value, digits = 2) {
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatPctWeight(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function boolText(value) {
  return value === true || value === "True" || value === "true" || value === 1 || value === "1" ? "Yes" : "No";
}

function rankPayload(profileKey, filters, isCustom, weights, limit = 25) {
  const payload = { profile: isCustom ? "residential_homestead" : profileKey, min_score: Number(filters.minScore || 0), limit };
  if (isCustom) payload.weights = Object.fromEntries(Object.entries(weights).filter(([, weight]) => Number(weight) > 0));
  if (filters.maxFloodplainPct !== "") payload.max_floodplain_pct = Number(filters.maxFloodplainPct);
  if (filters.maxWetlandPct !== "") payload.max_wetland_pct = Number(filters.maxWetlandPct);
  if (filters.minAreaAcres !== "") payload.min_area_acres = Number(filters.minAreaAcres);
  if (filters.maxDistanceToRoadM !== "") payload.max_distance_to_road_m = Number(filters.maxDistanceToRoadM);
  if (filters.maxDistanceToTownKm !== "") payload.max_distance_to_town_km = Number(filters.maxDistanceToTownKm);
  if (filters.streamPresent !== "any") payload.stream_present = filters.streamPresent === "yes";
  return payload;
}

function popupHtml(unitId, score, profileLabel) {
  return `<div style="color:#0f172a;min-width:180px"><div style="font-weight:700;font-size:14px;margin-bottom:4px">Parcel ${unitId ?? "—"}</div><div style="font-size:13px;line-height:1.35"><div><strong>${profileLabel}</strong></div><div>Suitability: <strong>${formatNumber(score, 1)} / 100</strong></div></div></div>`;
}

function MetricRow({ label, value, suffix = "" }) {
  return <div className="flex justify-between gap-3 border-b border-slate-800 py-1 text-sm"><span className="text-slate-400">{label}</span><span className="text-right font-medium">{value}{value !== "—" ? suffix : ""}</span></div>;
}

function Legend() {
  const items = [
    ["Very High", "80–100", "#166534"],
    ["High", "65–79", "#22c55e"],
    ["Moderate", "50–64", "#facc15"],
    ["Low", "35–49", "#f97316"],
    ["Very Low", "0–34", "#dc2626"],
  ];
  return <div className="space-y-2">{items.map(([label, range, color]) => <div className="flex items-center justify-between text-sm" key={label}><span className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm" style={{ backgroundColor: color }} />{label}</span><span className="text-slate-400">{range}</span></div>)}</div>;
}

export default function App() {
  const mapDiv = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [parcelIndex, setParcelIndex] = useState(new Map());
  const [profileKey, setProfileKey] = useState("residential_homestead");
  const [isCustomProfile, setIsCustomProfile] = useState(false);
  const [customWeights, setCustomWeights] = useState(fillAllWeights(PROFILE_DEFS.residential_homestead.weights));
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [selectedParcel, setSelectedParcel] = useState(null);
  const [selectedUnitId, setSelectedUnitId] = useState(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [ranked, setRanked] = useState([]);
  const [rankError, setRankError] = useState("");
  const [rankLoading, setRankLoading] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [analysisVisible, setAnalysisVisible] = useState(true);
  const [citiesVisible, setCitiesVisible] = useState(true);
  const [baseLayer, setBaseLayer] = useState("osm");
  const [panelOpen, setPanelOpen] = useState(true);

  const presetProfile = useMemo(() => PROFILE_DEFS[profileKey] || PROFILE_DEFS.residential_homestead, [profileKey]);
  const activeProfileLabel = isCustomProfile ? "Custom Suitability Profile" : presetProfile.label;
  const activeWeights = isCustomProfile ? customWeights : fillAllWeights(presetProfile.weights);
  const activeWeightSum = Object.values(activeWeights).reduce((a, b) => a + Number(b || 0), 0);

  const selectedScore = useMemo(() => {
    if (!selectedParcel) return null;
    if (isCustomProfile) return calculateCustomScore(selectedParcel, customWeights);
    return selectedParcel?.api_score ?? selectedParcel?.[presetProfile.scoreField];
  }, [selectedParcel, isCustomProfile, customWeights, presetProfile]);

  const selectedClass = useMemo(() => {
    if (!selectedParcel) return "—";
    if (isCustomProfile) return classFromScore(selectedScore);
    return selectedParcel?.api_class ?? selectedParcel?.[presetProfile.classField] ?? classFromScore(selectedScore);
  }, [selectedParcel, isCustomProfile, selectedScore, presetProfile]);

  useEffect(() => {
    fetch("/data/parcel_index.json")
      .then((r) => r.json())
      .then((rows) => {
        const lookup = new Map();
        rows.forEach((row) => lookup.set(String(row.unit_id), row));
        setParcelIndex(lookup);
      })
      .catch(console.warn);
  }, []);

  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return;
    try {
      const protocol = new Protocol();
      maplibregl.addProtocol("pmtiles", protocol.tile);
      const map = new maplibregl.Map({
        container: mapDiv.current,
        center: [-91.0, 38.45],
        zoom: 9.5,
        style: {
          version: 8,
          sources: {
            osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" },
            topo: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, attribution: "Tiles © Esri" },
            parcels: { type: "vector", url: "pmtiles:///data/terrascope_parcels.pmtiles" },
            cities: { type: "geojson", data: "/data/city_reference_points.geojson" },
            selectedParcel: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
          },
          layers: [
            { id: "osm", type: "raster", source: "osm", layout: { visibility: "visible" } },
            { id: "topo", type: "raster", source: "topo", layout: { visibility: "none" } },
            { id: "parcels-fill", type: "fill", source: "parcels", "source-layer": "parcels", paint: { "fill-color": presetFillExpression("residential_homestead_score"), "fill-opacity": 0.58 } },
            { id: "parcels-line", type: "line", source: "parcels", "source-layer": "parcels", paint: { "line-color": "#0f172a", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.05, 12, 0.25, 15, 0.7], "line-opacity": 0.55 } },
            { id: "selected-parcel-fill", type: "fill", source: "selectedParcel", paint: { "fill-color": "#38bdf8", "fill-opacity": 0.28 } },
            { id: "selected-parcel-line-glow", type: "line", source: "selectedParcel", paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 4, 13, 7, 16, 10], "line-opacity": 0.9 } },
            { id: "selected-parcel-line", type: "line", source: "selectedParcel", paint: { "line-color": "#00e5ff", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2, 13, 4, 16, 6], "line-opacity": 1 } },
            { id: "city-circles", type: "circle", source: "cities", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 11, 10, 20, 13, 31], "circle-color": "#0284c7", "circle-opacity": 0.32, "circle-stroke-color": "#0ea5e9", "circle-stroke-width": 3, "circle-stroke-opacity": 1 } },
            { id: "city-labels", type: "symbol", source: "cities", minzoom: 9, layout: { "text-field": ["get", "town_name"], "text-size": 12, "text-offset": [0, 1.7], "text-anchor": "top" }, paint: { "text-color": "#dff6ff", "text-halo-color": "#075985", "text-halo-width": 1.7 } },
          ],
        },
      });

      map.addControl(new maplibregl.NavigationControl(), "top-left");
      map.on("load", () => setReady(true));
      map.on("click", "parcels-fill", async (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties || {};
        const unitId = props.unit_id;
        const score = isCustomProfile ? calculateCustomScore(props, customWeights) : props[presetProfile.scoreField];
        setSelectedUnitId(String(unitId));
        setSelectedParcel(props);
        showBasicPopup(e.lngLat, unitId, score);
        setSelectedFeatureFromMapFeature(feature);
        await loadParcelDetails(unitId, props);
      });
      map.on("mousemove", "parcels-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "parcels-fill", () => { map.getCanvas().style.cursor = ""; });
      map.on("click", "city-circles", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties || {};
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<div style="color:#0f172a"><strong>${p.town_name || "Service Center"}</strong><br/>${p.role || ""}</div>`).addTo(map);
      });
      mapRef.current = map;
    } catch (err) {
      setMapError(err.message);
    }
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      try { maplibregl.removeProtocol("pmtiles"); } catch {}
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer("parcels-fill")) return;
    map.setPaintProperty("parcels-fill", "fill-color", isCustomProfile ? customFillExpression(customWeights) : presetFillExpression(presetProfile.scoreField));
  }, [ready, isCustomProfile, customWeights, presetProfile]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    ["parcels-fill", "parcels-line"].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", analysisVisible ? "visible" : "none"));
  }, [ready, analysisVisible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    ["city-circles", "city-labels"].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", citiesVisible ? "visible" : "none"));
  }, [ready, citiesVisible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setLayoutProperty("osm", "visibility", baseLayer === "osm" ? "visible" : "none");
    map.setLayoutProperty("topo", "visibility", baseLayer === "topo" ? "visible" : "none");
  }, [ready, baseLayer]);

  function handlePresetChange(newKey) {
    setProfileKey(newKey);
    setIsCustomProfile(false);
    setCustomWeights(fillAllWeights(PROFILE_DEFS[newKey].weights));
  }

  function updateWeight(field, value) {
    setIsCustomProfile(true);
    setCustomWeights((prev) => ({ ...prev, [field]: Math.max(0, Number(value) / 100) }));
  }

  function showBasicPopup(lngLat, unitId, score) {
    const map = mapRef.current;
    if (!map) return;
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: false }).setLngLat(lngLat).setHTML(popupHtml(unitId, score, activeProfileLabel)).addTo(map);
  }

  function setSelectedFeatureFromMapFeature(feature) {
    const selectedSource = mapRef.current?.getSource("selectedParcel");
    if (!selectedSource || !feature?.geometry) return;
    selectedSource.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: feature.properties || {}, geometry: feature.geometry }] });
  }

  function clearSelectedFeature() {
    mapRef.current?.getSource("selectedParcel")?.setData({ type: "FeatureCollection", features: [] });
  }

  async function loadParcelDetails(unitId, mapProps = {}) {
    setLookupLoading(true);
    try {
      const full = await fetchParcel(unitId);
      setSelectedParcel({ ...mapProps, ...full });
    } catch (err) {
      setSelectedParcel({ ...mapProps, unit_id: unitId, lookup_error: err.message });
    } finally {
      setLookupLoading(false);
    }
  }

  function parcelCenter(unitId) {
    const row = parcelIndex.get(String(unitId));
    if (!row) return null;
    return [(Number(row.west) + Number(row.east)) / 2, (Number(row.south) + Number(row.north)) / 2];
  }

  function zoomToParcel(unitId) {
    const row = parcelIndex.get(String(unitId));
    const map = mapRef.current;
    if (!row || !map) return;
    map.fitBounds([[Number(row.west), Number(row.south)], [Number(row.east), Number(row.north)]], { padding: 90, maxZoom: 16, duration: 750 });
  }

  function highlightVisibleParcelByUnitId(unitId) {
    const map = mapRef.current;
    if (!map?.getLayer("parcels-fill")) return;
    const match = map.queryRenderedFeatures({ layers: ["parcels-fill"] }).find((f) => String(f.properties?.unit_id) === String(unitId));
    if (match) setSelectedFeatureFromMapFeature(match);
  }

  async function selectParcelFromSearch(parcel) {
    const unitId = parcel.unit_id;
    const score = isCustomProfile ? parcel.api_score ?? calculateCustomScore(parcel, customWeights) : parcel.api_score ?? parcel[presetProfile.scoreField];
    setSelectedUnitId(String(unitId));
    setSelectedParcel(parcel);
    const center = parcelCenter(unitId);
    if (center) showBasicPopup(center, unitId, score);
    zoomToParcel(unitId);
    if (window.innerWidth < 768) setPanelOpen(false);
    window.setTimeout(() => highlightVisibleParcelByUnitId(unitId), 800);
    await loadParcelDetails(unitId, parcel);
  }

  async function runRankSearch() {
    setRankLoading(true);
    setRankError("");
    try {
      const data = await fetchRankedParcels(rankPayload(presetProfile.key, filters, isCustomProfile, customWeights));
      setRanked(data.results || []);
    } catch (err) {
      setRankError(err.message);
    } finally {
      setRankLoading(false);
    }
  }

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      {!panelOpen && (
        <button
          className="fixed left-3 top-3 z-40 flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/95 px-3 py-2 text-sm font-semibold text-slate-100 shadow-xl backdrop-blur hover:border-emerald-400"
          onClick={() => setPanelOpen(true)}
        >
          <Menu className="h-4 w-4 text-emerald-400" />
          Panel
        </button>
      )}

      {panelOpen && (
        <button
          className="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm md:hidden"
          onClick={() => setPanelOpen(false)}
          aria-label="Close side panel backdrop"
        />
      )}

      <aside
        className={`fixed left-0 top-0 z-40 flex h-screen w-[92vw] max-w-[420px] flex-col border-r border-slate-800 bg-slate-950 shadow-2xl transition-transform duration-300 md:w-[420px] ${
          panelOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-slate-800 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <MapPinned className="h-6 w-6 text-emerald-400" />
              <h1 className="text-2xl font-bold">TerraScope</h1>
            </div>
            <button className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-emerald-400 hover:text-white" onClick={() => setPanelOpen(false)} aria-label="Close side panel">
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-2 text-sm text-slate-300">Rural land suitability screening for Franklin County, Missouri.</p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="mb-3 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-emerald-400" />
              <h2 className="font-semibold">Suitability Profile</h2>
            </div>

            <div className="relative">
              <select className="h-10 w-full appearance-none rounded-xl border border-slate-700 bg-slate-950 px-3 pr-10 text-sm text-slate-100 outline-none focus:border-emerald-400" value={profileKey} onChange={(e) => handlePresetChange(e.target.value)}>
                {PROFILE_OPTIONS.map((profile) => <option key={profile.key} value={profile.key}>{profile.label}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>

            {isCustomProfile && <div className="mt-2 rounded-lg border border-cyan-800 bg-cyan-950/40 p-2 text-sm text-cyan-200">Custom suitability profile active for this session.</div>}

            <button className="mt-3 flex h-10 w-full items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none hover:border-emerald-500 focus:border-emerald-400" onClick={() => setWeightsOpen(!weightsOpen)}>
              <span className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-emerald-400" />Variables & Weights</span>
              {weightsOpen ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
            </button>

            {weightsOpen && (
              <div className="mt-3 space-y-3">
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">Weights are shown as percentages. Editing any value switches the session to <strong className="text-cyan-300">Custom</strong>. Use Normalize to make weights add to 100%.</div>
                <div className={`rounded-lg border p-2 text-sm ${Math.abs(activeWeightSum - 1) < 0.001 ? "border-slate-800 bg-slate-950 text-slate-300" : "border-yellow-700 bg-yellow-950/30 text-yellow-200"}`}>Current total weight: <strong>{formatPctWeight(activeWeightSum)}</strong></div>
                {ALL_WEIGHT_FIELDS.map((field) => {
                  const [label, description] = WEIGHT_META[field];
                  const value = activeWeights[field] || 0;
                  return (
                    <div key={field} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <div><p className="text-sm font-semibold text-slate-100">{label}</p><p className="text-xs leading-4 text-slate-500">{description}</p></div>
                        <input className="w-20 rounded-lg border border-slate-700 bg-slate-900 p-1.5 text-right text-sm" type="number" min="0" step="1" value={(value * 100).toFixed(1)} onChange={(e) => updateWeight(field, e.target.value)} />
                      </div>
                      <input className="w-full accent-emerald-400" type="range" min="0" max="100" step="1" value={value * 100} onChange={(e) => updateWeight(field, e.target.value)} />
                    </div>
                  );
                })}
                <div className="grid grid-cols-2 gap-2">
                  <button className="rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400" onClick={() => { setIsCustomProfile(true); setCustomWeights((prev) => normalizeWeights(prev)); }}>Normalize to 100%</button>
                  <button className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800" onClick={() => { setIsCustomProfile(false); setCustomWeights(fillAllWeights(presetProfile.weights)); }}>Reset to Preset</button>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="mb-3 flex items-center gap-2"><Layers className="h-4 w-4 text-emerald-400" /><h2 className="font-semibold">Map Layers</h2></div>
            <div className="space-y-3 text-sm">
              <label className="flex items-center justify-between gap-4"><span>Base layer</span><select className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-2 pr-8 text-sm text-slate-100 outline-none focus:border-emerald-400" value={baseLayer} onChange={(e) => setBaseLayer(e.target.value)}><option value="osm">OpenStreetMap</option><option value="topo">Topo</option></select></label>
              <label className="flex items-center justify-between"><span>Analysis Map</span><input type="checkbox" checked={analysisVisible} onChange={(e) => setAnalysisVisible(e.target.checked)} /></label>
              <label className="flex items-center justify-between"><span>Cities / Service Centers</span><input type="checkbox" checked={citiesVisible} onChange={(e) => setCitiesVisible(e.target.checked)} /></label>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="mb-3 flex items-center gap-2"><Info className="h-4 w-4 text-emerald-400" /><h2 className="font-semibold">Legend</h2></div>
            <Legend />
            <div className="mt-4 border-t border-slate-800 pt-3 text-sm text-slate-300">
              <div className="flex items-center gap-2"><span className="inline-block h-4 w-4 rounded-full border-2 border-sky-400 bg-sky-500/30" /><span>City / service center reference</span></div>
              <div className="mt-2 flex items-center gap-2"><span className="inline-block h-4 w-4 border-2 border-cyan-300 bg-cyan-400/25 shadow" /><span>Selected parcel</span></div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="mb-3 flex items-center gap-2"><Filter className="h-4 w-4 text-emerald-400" /><h2 className="font-semibold">Ranked Search</h2></div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">Min score<input className="mt-1 w-full rounded bg-slate-950 p-2" type="number" value={filters.minScore} onChange={(e) => setFilters({ ...filters, minScore: e.target.value })} /></label>
              <label className="text-xs text-slate-400">Min acres<input className="mt-1 w-full rounded bg-slate-950 p-2" type="number" value={filters.minAreaAcres} onChange={(e) => setFilters({ ...filters, minAreaAcres: e.target.value })} /></label>
              <label className="text-xs text-slate-400">Max flood %<input className="mt-1 w-full rounded bg-slate-950 p-2" type="number" value={filters.maxFloodplainPct} onChange={(e) => setFilters({ ...filters, maxFloodplainPct: e.target.value })} /></label>
              <label className="text-xs text-slate-400">Max wetland %<input className="mt-1 w-full rounded bg-slate-950 p-2" type="number" value={filters.maxWetlandPct} onChange={(e) => setFilters({ ...filters, maxWetlandPct: e.target.value })} /></label>
              <label className="text-xs text-slate-400">Max road m<input className="mt-1 w-full rounded bg-slate-950 p-2" type="number" value={filters.maxDistanceToRoadM} onChange={(e) => setFilters({ ...filters, maxDistanceToRoadM: e.target.value })} /></label>
              <label className="text-xs text-slate-400">Max town km<input className="mt-1 w-full rounded bg-slate-950 p-2" type="number" value={filters.maxDistanceToTownKm} onChange={(e) => setFilters({ ...filters, maxDistanceToTownKm: e.target.value })} /></label>
              <label className="col-span-2 text-xs text-slate-400">Stream present<select className="mt-1 w-full rounded bg-slate-950 p-2" value={filters.streamPresent} onChange={(e) => setFilters({ ...filters, streamPresent: e.target.value })}><option value="any">Any</option><option value="yes">Yes</option><option value="no">No</option></select></label>
            </div>
            <div className="mt-3 flex gap-2">
              <button className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950" onClick={runRankSearch}><Search className="h-4 w-4" />Search</button>
              <button className="rounded-xl border border-slate-700 px-3 py-2" onClick={() => { setFilters(DEFAULT_FILTERS); setRanked([]); setRankError(""); setSelectedUnitId(null); clearSelectedFeature(); }}><RotateCcw className="h-4 w-4" /></button>
            </div>
            {rankLoading && <p className="mt-3 text-sm text-slate-400">Loading...</p>}
            {rankError && <p className="mt-3 rounded bg-red-950 p-2 text-sm text-red-200">{rankError}</p>}
            {ranked.length > 0 && <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">{ranked.map((parcel, i) => {
              const score = isCustomProfile ? parcel.api_score ?? calculateCustomScore(parcel, customWeights) : parcel.api_score ?? parcel[presetProfile.scoreField];
              return <button key={`${parcel.unit_id}-${i}`} className={`w-full rounded-xl border p-3 text-left hover:border-emerald-500 ${String(parcel.unit_id) === String(selectedUnitId) ? "border-cyan-300 bg-cyan-950/40" : "border-slate-800 bg-slate-950"}`} onClick={() => selectParcelFromSearch(parcel)}><div className="flex justify-between"><span className="font-semibold">#{i + 1} {parcel.unit_id}</span><span className="text-emerald-300">{formatNumber(score, 1)}</span></div><div className="text-xs text-slate-400">{formatNumber(parcel.area_acres, 1)} acres · flood {formatNumber(parcel.floodplain_pct, 1)}%</div></button>;
            })}</div>}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <h2 className="mb-3 font-semibold">Selected Parcel</h2>
            {lookupLoading && <p className="mb-2 text-sm text-slate-400">Loading backend details...</p>}
            {selectedParcel ? <div>
              <div className="mb-3 rounded-xl bg-slate-950 p-3"><div className="flex justify-between"><div><p className="text-xs text-slate-500">Parcel ID</p><p className="font-semibold">{selectedParcel.unit_id}</p></div><div className="text-right"><p className="text-xs text-slate-500">Score</p><p className="text-xl font-bold text-emerald-300">{formatNumber(selectedScore, 1)}</p></div></div><p className="mt-2 text-sm text-slate-400">{selectedClass || "—"}</p></div>
              {selectedParcel.lookup_error && <p className="mb-3 rounded bg-yellow-950 p-2 text-sm text-yellow-200">Backend lookup failed: {selectedParcel.lookup_error}</p>}
              <MetricRow label="Area" value={formatNumber(selectedParcel.area_acres, 2)} suffix=" acres" />
              <MetricRow label="Slope score" value={formatNumber(selectedParcel.slope_score, 1)} />
              <MetricRow label="Access score" value={formatNumber(selectedParcel.access_score, 1)} />
              <MetricRow label="Proximity score" value={formatNumber(selectedParcel.proximity_score, 1)} />
              <MetricRow label="Risk score" value={formatNumber(selectedParcel.risk_score, 1)} />
              <MetricRow label="Vegetation score" value={formatNumber(selectedParcel.vegetation_score, 1)} />
              <MetricRow label="Avg slope" value={formatNumber(selectedParcel.avg_slope_pct, 1)} suffix="%" />
              <MetricRow label="Floodplain" value={formatNumber(selectedParcel.floodplain_pct, 1)} suffix="%" />
              <MetricRow label="Wetland" value={formatNumber(selectedParcel.wetland_pct, 1)} suffix="%" />
              <MetricRow label="Stream present" value={selectedParcel.stream_present === undefined ? "—" : boolText(selectedParcel.stream_present)} />
              <MetricRow label="Nearest road" value={formatNumber(selectedParcel.distance_to_nearest_road_m, 0)} suffix=" m" />
              <MetricRow label="Nearest town" value={selectedParcel.nearest_town || "—"} />
              <MetricRow label="Town distance" value={formatNumber(selectedParcel.distance_to_nearest_town_km, 1)} suffix=" km" />
            </div> : <p className="text-sm text-slate-400">Click a parcel or choose one from ranked search.</p>}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-xs text-slate-400">TerraScope is an exploratory geospatial decision-support tool. Custom weights are session-only and are not saved.</section>
        </div>
      </aside>

      <main className="relative h-screen flex-1">
        {mapError && <div className="absolute left-4 top-4 z-10 rounded bg-red-950 p-4 text-sm text-red-200">{mapError}</div>}
        {!ready && !mapError && <div className="absolute left-4 top-4 z-10 rounded bg-slate-950 p-4 text-sm">Loading TerraScope vector tiles...</div>}
        <div ref={mapDiv} className="h-full w-full" />
      </main>
    </div>
  );
}
