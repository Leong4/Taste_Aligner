import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { resolveUkLocation, searchMemory } from "../api";
import type { SearchResult } from "../types";

const WORLD_TOPOLOGY_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const UK_TOPOLOGY_URL =
  "https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/administrative/gb/topo_lad.json";

const MAP_SEARCH_TAGS = [
  "travel",
  "food",
  "scenery",
  "culture",
  "nature",
  "city",
  "landscape",
  "restaurant",
  "cafe",
  "ramen",
];

const CITY_TO_COUNTRY: Record<string, string> = {
  tokyo: "JPN",
  barcelona: "ESP",
  london: "GBR",
  paris: "FRA",
  new_york: "USA",
  los_angeles: "USA",
  singapore: "SGP",
  bangkok: "THA",
  hong_kong: "HKG",
  seoul: "KOR",
  amsterdam: "NLD",
  rome: "ITA",
  berlin: "DEU",
  sydney: "AUS",
  dubai: "ARE",
  istanbul: "TUR",
  madrid: "ESP",
  lisbon: "PRT",
  vienna: "AUT",
  prague: "CZE",
  budapest: "HUN",
  copenhagen: "DNK",
  stockholm: "SWE",
  osaka: "JPN",
  kyoto: "JPN",
  shanghai: "CHN",
  beijing: "CHN",
  mumbai: "IND",
  bali: "IDN",
  kuala_lumpur: "MYS",
  edinburgh: "GBR",
  manchester: "GBR",
  birmingham: "GBR",
  bath: "GBR",
  bristol: "GBR",
  leeds: "GBR",
  sheffield: "GBR",
  liverpool: "GBR",
  glasgow: "GBR",
  cambridge: "GBR",
  oxford: "GBR",
  brighton: "GBR",
  york: "GBR",
  nottingham: "GBR",
  cardiff: "GBR",
};

const COUNTRY_ISO_TO_NUMERIC: Record<string, string> = {
  ARE: "784",
  AUS: "036",
  AUT: "040",
  CHN: "156",
  CZE: "203",
  DEU: "276",
  DNK: "208",
  ESP: "724",
  FRA: "250",
  GBR: "826",
  HKG: "344",
  HUN: "348",
  IDN: "360",
  IND: "356",
  ITA: "380",
  JPN: "392",
  KOR: "410",
  MYS: "458",
  NLD: "528",
  PRT: "620",
  SGP: "702",
  SWE: "752",
  THA: "764",
  TUR: "792",
  USA: "840",
};

const UK_CITY_TO_LOCATION: Record<string, string> = {
  london: "Greater London",
  bath: "Bath and North East Somerset",
  bristol: "Bristol",
  manchester: "Greater Manchester",
  birmingham: "Birmingham",
  edinburgh: "City of Edinburgh",
  glasgow: "Glasgow City",
  leeds: "Leeds",
  sheffield: "Sheffield",
  liverpool: "Liverpool",
  cambridge: "Cambridgeshire",
  oxford: "Oxfordshire",
  brighton: "Brighton and Hove",
  york: "York",
  nottingham: "Nottinghamshire",
  cardiff: "Cardiff",
};

const GREATER_LONDON_LADS = [
  "Barking and Dagenham",
  "Barnet",
  "Bexley",
  "Brent",
  "Bromley",
  "Camden",
  "City of London",
  "Croydon",
  "Ealing",
  "Enfield",
  "Greenwich",
  "Hackney",
  "Hammersmith and Fulham",
  "Haringey",
  "Harrow",
  "Havering",
  "Hillingdon",
  "Hounslow",
  "Islington",
  "Kensington and Chelsea",
  "Kingston upon Thames",
  "Lambeth",
  "Lewisham",
  "Merton",
  "Newham",
  "Redbridge",
  "Richmond upon Thames",
  "Southwark",
  "Sutton",
  "Tower Hamlets",
  "Waltham Forest",
  "Wandsworth",
  "Westminster",
];

const UK_LOCATION_TO_LADS: Record<string, string[]> = {
  "Greater London": GREATER_LONDON_LADS,
  "Bath and North East Somerset": ["Bath and North East Somerset"],
  Bristol: ["Bristol, City of"],
  "Greater Manchester": [
    "Bolton",
    "Bury",
    "Manchester",
    "Oldham",
    "Rochdale",
    "Salford",
    "Stockport",
    "Tameside",
    "Trafford",
    "Wigan",
  ],
  Birmingham: ["Birmingham"],
  "City of Edinburgh": ["City of Edinburgh"],
  "Glasgow City": ["Glasgow City"],
  Leeds: ["Leeds"],
  Sheffield: ["Sheffield"],
  Liverpool: ["Liverpool"],
  Cambridgeshire: ["Cambridge", "East Cambridgeshire", "Fenland", "Huntingdonshire", "South Cambridgeshire"],
  Oxfordshire: ["Cherwell", "Oxford", "South Oxfordshire", "Vale of White Horse", "West Oxfordshire"],
  "Brighton and Hove": ["Brighton and Hove"],
  York: ["York"],
  Nottinghamshire: ["Ashfield", "Bassetlaw", "Broxtowe", "Gedling", "Mansfield", "Newark and Sherwood", "Rushcliffe"],
  Cardiff: ["Cardiff"],
};

const COMING_SOON = [
  "🇨🇳 China provinces",
  "🇯🇵 Japan prefectures",
  "🇫🇷 France regions",
  "🇮🇹 Italy regions",
  "🇩🇪 Germany states",
  "🇺🇸 US states",
  "🇪🇸 Spain regions",
];

type MapView = "world" | "uk";

interface TopologyPayload {
  objects: Record<string, unknown>;
}

interface MapProperties {
  name?: string;
  LAD13NM?: string;
}

interface LocationSummary {
  memoryCount: number;
  cities: Set<string>;
  tags: Map<string, number>;
}

interface TooltipState {
  x: number;
  y: number;
  name: string;
  memoryCount: number;
  tags: string[];
}

export default function MapPage() {
  const svgRef = useRef<SVGSVGElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MapView>("world");
  const [worldTopology, setWorldTopology] = useState<TopologyPayload | null>(null);
  const [ukTopology, setUkTopology] = useState<TopologyPayload | null>(null);
  const [memories, setMemories] = useState<SearchResult[]>([]);
  const [resolvedUkLocations, setResolvedUkLocations] = useState<Record<string, string | null>>({});
  const [resolvingUkLocations, setResolvingUkLocations] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const resolvedUkLocationCache = useRef(new Map<string, string | null>());

  const ukLocationToLads = useMemo(() => {
    const locations = { ...UK_LOCATION_TO_LADS };
    for (const location of Object.values(resolvedUkLocations)) {
      if (location && !locations[location]) locations[location] = [location];
    }
    return locations;
  }, [resolvedUkLocations]);

  const ukLadToLocation = useMemo(
    () =>
      new Map(
        Object.entries(ukLocationToLads).flatMap(([location, lads]) =>
          lads.map((lad) => [lad, location] as const),
        ),
      ),
    [ukLocationToLads],
  );

  const countrySummaries = useMemo(() => {
    const summaries = new Map<string, LocationSummary>();
    for (const memory of memories) {
      const city = normalizeCity(memory.city);
      const country = city ? CITY_TO_COUNTRY[city] : undefined;
      if (city && country) addMemory(summaries, country, city, memory);
    }
    return summaries;
  }, [memories]);

  const ukSummaries = useMemo(() => {
    const summaries = new Map<string, LocationSummary>();
    for (const memory of memories) {
      const city = normalizeCity(memory.city);
      const location = city ? UK_CITY_TO_LOCATION[city] ?? resolvedUkLocations[city] : undefined;
      if (city && location) addMemory(summaries, location, city, memory);
    }
    return summaries;
  }, [memories, resolvedUkLocations]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      fetchTopology(WORLD_TOPOLOGY_URL),
      searchMemory({ query_tags: MAP_SEARCH_TAGS, top_k: 50 }),
    ])
      .then(([topologyResult, memoriesResult]) => {
        if (cancelled) return;
        const errors: string[] = [];
        if (topologyResult.status === "fulfilled") {
          setWorldTopology(topologyResult.value);
        } else {
          errors.push(errorMessage(topologyResult.reason));
        }
        if (memoriesResult.status === "fulfilled") {
          setMemories(memoriesResult.value);
        } else {
          errors.push(errorMessage(memoriesResult.reason));
        }
        setError(errors.length > 0 ? errors.join(" ") : null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchTopology(UK_TOPOLOGY_URL)
      .then((topology) => {
        if (!cancelled) setUkTopology(topology);
      })
      .catch((err: unknown) => {
        if (!cancelled) console.warn(`[map] Failed to load UK LAD topology: ${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ukTopology) return;
    const lads = toFeatureCollection(ukTopology, "lad");
    const validLocations = lads.features
      .map((datum) => datum.properties.LAD13NM)
      .filter((name): name is string => typeof name === "string");
    const validLocationSet = new Set(validLocations);
    const unknownCities = [
      ...new Set(
        memories
          .map((memory) => normalizeCity(memory.city))
          .filter((city): city is string => city !== null && !UK_CITY_TO_LOCATION[city]),
      ),
    ];

    for (const [location, locationLads] of Object.entries(UK_LOCATION_TO_LADS)) {
      for (const lad of locationLads) {
        if (!validLocationSet.has(lad)) {
          console.warn(`[map] No exact UK LAD match for static location="${location}": "${lad}"`);
        }
      }
    }

    const citiesToResolve = unknownCities.filter((city) => !resolvedUkLocationCache.current.has(city));
    if (citiesToResolve.length === 0) {
      setResolvedUkLocations(Object.fromEntries(resolvedUkLocationCache.current));
      return;
    }

    let cancelled = false;
    setResolvingUkLocations(true);
    Promise.all(
      citiesToResolve.map(async (city) => {
        try {
          const location = await resolveUkLocation(city, validLocations);
          if (location !== null && !validLocationSet.has(location)) {
            console.warn(`[map] No exact UK LAD match for resolved city="${city}": "${location}"`);
            return [city, null] as const;
          }
          return [city, location] as const;
        } catch (err) {
          console.warn(`[map] UK location fallback failed for city="${city}": ${errorMessage(err)}`);
          return [city, null] as const;
        }
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        for (const [city, location] of entries) resolvedUkLocationCache.current.set(city, location);
        setResolvedUkLocations(Object.fromEntries(resolvedUkLocationCache.current));
      })
      .finally(() => {
        if (!cancelled) setResolvingUkLocations(false);
      });
    return () => {
      cancelled = true;
    };
  }, [memories, ukTopology]);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement) return;

    const width = 1200;
    const height = 620;
    const svg = d3.select(svgElement);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    if (view === "world" && worldTopology) {
      const countries = toFeatureCollection(worldTopology, "countries");
      const projection = d3.geoNaturalEarth1().fitExtent(
        [
          [18, 18],
          [width - 18, height - 18],
        ],
        countries,
      );
      const path = d3.geoPath(projection);

      svg
        .append("g")
        .selectAll<SVGPathElement, Feature<Geometry, MapProperties>>("path")
        .data(countries.features)
        .join("path")
        .attr("d", (datum) => path(datum) ?? "")
        .attr("aria-label", (datum) => datum.properties.name ?? "Unknown country")
        .attr("data-country-code", (datum) => numericCountryIdToIso(datum.id))
        .attr("fill", (datum) => {
          const summary = countrySummaries.get(numericCountryIdToIso(datum.id));
          return summary ? visitedColor(summary.cities.size) : "#2d2d3f";
        })
        .attr("stroke", "#4b4b63")
        .attr("stroke-width", 0.65)
        .style("cursor", (datum) => (numericCountryIdToIso(datum.id) === "GBR" ? "pointer" : "default"))
        .on("mouseenter", (event, datum) => {
          const summary = countrySummaries.get(numericCountryIdToIso(datum.id));
          if (summary) showTooltip(event, datum.properties.name ?? "Unknown country", summary);
        })
        .on("mousemove", (event, datum) => {
          const summary = countrySummaries.get(numericCountryIdToIso(datum.id));
          if (summary) showTooltip(event, datum.properties.name ?? "Unknown country", summary);
        })
        .on("mouseleave", () => setTooltip(null))
        .on("click", (_event, datum) => {
          if (numericCountryIdToIso(datum.id) === "GBR") {
            setTooltip(null);
            setView("uk");
          }
        });
    }

    if (view === "uk" && ukTopology && !resolvingUkLocations) {
      const lads = toFeatureCollection(ukTopology, "lad");
      const projection = d3.geoMercator().fitExtent(
        [
          [90, 18],
          [width - 90, height - 18],
        ],
        lads,
      );
      const path = d3.geoPath(projection);

      svg
        .append("g")
        .selectAll<SVGPathElement, Feature<Geometry, MapProperties>>("path")
        .data(lads.features)
        .join("path")
        .attr("d", (datum) => path(datum) ?? "")
        .attr("aria-label", (datum) => datum.properties.LAD13NM ?? "Unknown location")
        .attr("data-location", (datum) => ukLadToLocation.get(datum.properties.LAD13NM ?? "") ?? "")
        .attr("fill", (datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          return location && ukSummaries.has(location) ? "#f59e0b" : "#2d2d3f";
        })
        .attr("stroke", "#4b4b63")
        .attr("stroke-width", 0.55)
        .on("mouseenter", (event, datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          const summary = location ? ukSummaries.get(location) : undefined;
          if (location && summary) showTooltip(event, location, summary);
        })
        .on("mousemove", (event, datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          const summary = location ? ukSummaries.get(location) : undefined;
          if (location && summary) showTooltip(event, location, summary);
        })
        .on("mouseleave", () => setTooltip(null));
    }

    function showTooltip(event: PointerEvent, name: string, summary: LocationSummary) {
      const [x, y] = d3.pointer(event, mapRef.current);
      setTooltip({
        x: x + 14,
        y: y + 14,
        name,
        memoryCount: summary.memoryCount,
        tags: topTags(summary),
      });
    }
  }, [countrySummaries, resolvingUkLocations, ukLadToLocation, ukSummaries, ukTopology, view, worldTopology]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem" }}>
        {view === "uk" && (
          <button className="btn btn-ghost" type="button" onClick={() => setView("world")}>
            ← Back to world
          </button>
        )}
        <div>
          <h2 style={{ margin: 0 }}>{view === "world" ? "Your Taste Map" : "United Kingdom"}</h2>
          <p style={{ color: "#6b7280", marginTop: "0.4rem", fontSize: "0.9rem" }}>
            {view === "world"
              ? "Countries light up as your travel memories grow. Select the UK to explore its local map."
              : "Visited UK locations are highlighted from your saved memories."}
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div
        ref={mapRef}
        style={{
          position: "relative",
          width: "100%",
          overflow: "hidden",
          borderRadius: "16px",
          background: "#1a1a2e",
          boxShadow: "0 12px 32px rgba(17, 24, 39, 0.18)",
        }}
      >
        <svg
          ref={svgRef}
          aria-label={view === "world" ? "World taste map" : "United Kingdom taste map"}
          role="img"
          style={{ display: "block", width: "100%", height: "auto", minHeight: "360px" }}
        />
        {(loading || (view === "uk" && (!ukTopology || resolvingUkLocations))) && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#f59e0b",
              background: "rgba(26, 26, 46, 0.72)",
            }}
          >
            Loading map...
          </div>
        )}
        {tooltip && (
          <div
            style={{
              position: "absolute",
              left: tooltip.x,
              top: tooltip.y,
              pointerEvents: "none",
              maxWidth: "240px",
              padding: "0.75rem 0.85rem",
              border: "1px solid rgba(245, 158, 11, 0.45)",
              borderRadius: "10px",
              background: "rgba(17, 24, 39, 0.96)",
              color: "#f9fafb",
              boxShadow: "0 8px 20px rgba(0, 0, 0, 0.28)",
              fontSize: "0.82rem",
            }}
          >
            <div style={{ color: "#f59e0b", fontWeight: 700, marginBottom: "0.25rem" }}>
              {tooltip.name}
            </div>
            <div>{tooltip.memoryCount} {tooltip.memoryCount === 1 ? "memory" : "memories"}</div>
            <div style={{ color: "#d1d5db", marginTop: "0.2rem" }}>
              Top tags: {tooltip.tags.length > 0 ? tooltip.tags.join(", ") : "—"}
            </div>
          </div>
        )}
      </div>

      <div style={{ margin: "1rem 0 2rem", color: "#4b5563", fontSize: "0.95rem", fontWeight: 600 }}>
        {countrySummaries.size} countries explored · {memories.length} memories
      </div>

      <section className="card">
        <h3>Coming soon</h3>
        <div className="tags">
          {COMING_SOON.map((item) => (
            <span key={item} className="tag tag-gray">{item}</span>
          ))}
        </div>
      </section>
    </div>
  );
}

async function fetchTopology(url: string): Promise<TopologyPayload> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading map data`);
  return response.json() as Promise<TopologyPayload>;
}

function toFeatureCollection(topology: TopologyPayload, objectName: string) {
  return feature(topology as never, topology.objects[objectName] as never) as unknown as FeatureCollection<
    Geometry,
    MapProperties
  >;
}

function normalizeCity(city: string | undefined): string | null {
  if (!city) return null;
  return city.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function addMemory(summaries: Map<string, LocationSummary>, key: string, city: string, memory: SearchResult) {
  const summary = summaries.get(key) ?? {
    memoryCount: 0,
    cities: new Set<string>(),
    tags: new Map<string, number>(),
  };
  summary.memoryCount += 1;
  summary.cities.add(city);
  for (const tag of memory.normalized_tags ?? []) {
    summary.tags.set(tag, (summary.tags.get(tag) ?? 0) + 1);
  }
  summaries.set(key, summary);
}

function topTags(summary: LocationSummary): string[] {
  return [...summary.tags.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([tag]) => tag);
}

function visitedColor(cityCount: number): string {
  if (cityCount >= 3) return "#b45309";
  if (cityCount === 2) return "#d97706";
  return "#f59e0b";
}

function numericCountryIdToIso(id: string | number | undefined): string {
  const numericId = String(id ?? "").padStart(3, "0");
  return Object.entries(COUNTRY_ISO_TO_NUMERIC).find(([, numeric]) => numeric === numericId)?.[0] ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
