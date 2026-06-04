import { useEffect, useMemo, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
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
  "China Provinces",
  "Japan Prefectures",
  "US States",
  "Memory Globe",
];

const CORAL = "#FF6B5C";
const CORAL_HOVER = "#e05545";
const UNVISITED_FILL = "#2d2d3f";
const MOBILE_QUERY = "(max-width: 767px)";
const MEMORY_SERVICE_BASE_URL = "/api/memory";

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

interface MemoryPopupState {
  x: number;
  y: number;
  city: string;
  memoryCount: number;
  memories: Array<SearchResult & { image_url?: string; preview_url?: string }>;
  loading: boolean;
}

interface AtlasPhotoViewerState {
  memoryId: string;
  city: string;
}

interface MapSize {
  width: number;
  height: number;
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
  const [memoryPopup, setMemoryPopup] = useState<MemoryPopupState | null>(null);
  const [photoViewer, setPhotoViewer] = useState<AtlasPhotoViewerState | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mapTransitioning, setMapTransitioning] = useState(false);
  const [drawerExpanded, setDrawerExpanded] = useState(false);
  const [mapSize, setMapSize] = useState<MapSize>({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const resolvedUkLocationCache = useRef(new Map<string, string | null>());
  const drawerDragStart = useRef<number | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const homeTransformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const fullWorldTransformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);

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

  const uniqueCityCount = useMemo(
    () => new Set(memories.map((memory) => normalizeCity(memory.city)).filter(Boolean)).size,
    [memories],
  );

  const tasteProfile = useMemo(() => {
    const order = ["scenery", "food", "architecture", "other"] as const;
    const labels: Record<(typeof order)[number], string> = {
      scenery: "Scenery",
      food: "Food",
      architecture: "Architecture",
      other: "Other",
    };
    const counts = new Map<(typeof order)[number], number>(order.map((type) => [type, 0]));
    for (const memory of memories) {
      const type = normalizeVisionType(memory.vision_type);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return order.map((type) => {
      const count = counts.get(type) ?? 0;
      return {
        type,
        label: labels[type],
        count,
        percent: memories.length > 0 ? Math.round((count / memories.length) * 100) : 0,
      };
    });
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
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement) return;

    const updateMapSize = () => {
      const rect = svgElement.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      setMapSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };

    updateMapSize();
    const observer = new ResizeObserver(updateMapSize);
    observer.observe(svgElement);
    window.addEventListener("resize", updateMapSize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateMapSize);
    };
  }, []);

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

  function transitionToView(nextView: MapView) {
    if (nextView === view) return;
    setMapTransitioning(true);
    window.setTimeout(() => {
      setView(nextView);
      setMemoryPopup(null);
      setTooltip(null);
      if (nextView === "world") window.setTimeout(resetZoomHome, 80);
      window.setTimeout(() => setMapTransitioning(false), 150);
    }, 150);
  }

  function resetZoomHome() {
    zoomToTransform(homeTransformRef.current);
  }

  function resetZoomWorld() {
    zoomToTransform(fullWorldTransformRef.current);
  }

  function zoomToTransform(targetTransform: d3.ZoomTransform) {
    const svgElement = svgRef.current;
    const zoomBehavior = zoomBehaviorRef.current;
    if (!svgElement || !zoomBehavior) return;
    d3.select(svgElement)
      .transition()
      .duration(500)
      .call(zoomBehavior.transform, targetTransform);
  }

  function handleDrawerTouchStart(event: ReactTouchEvent) {
    drawerDragStart.current = event.touches[0]?.clientY ?? null;
  }

  function handleDrawerTouchMove(event: ReactTouchEvent) {
    if (drawerDragStart.current !== null) event.preventDefault();
  }

  function handleDrawerTouchEnd(event: ReactTouchEvent) {
    if (drawerDragStart.current === null || !isMobile) return;
    const deltaY = event.changedTouches[0].clientY - drawerDragStart.current;
    drawerDragStart.current = null;
    if (deltaY < -60) setDrawerExpanded(true);
    if (deltaY > 60) setDrawerExpanded(false);
  }

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement || mapSize.width === 0 || mapSize.height === 0) return;

    const { width, height } = mapSize;
    const svg = d3.select(svgElement);
    svg.selectAll("*").remove();
    const defs = svg.append("defs");
    defs.append("filter").attr("id", "country-glow").html(`
      <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    `);
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    if (view === "world" && worldTopology) {
      const countries = toFeatureCollection(worldTopology, "countries");
      const projection = d3.geoNaturalEarth1().fitExtent(
        paddedExtent(width, height, 18),
        countries,
      );
      const visitedFeatures = countries.features.filter((datum) =>
        countrySummaries.has(numericCountryIdToIso(datum.id)),
      );
      const visitedCollection = {
        type: "FeatureCollection" as const,
        features: visitedFeatures,
      };
      const center =
        visitedFeatures.length > 0
          ? d3.geoCentroid(visitedCollection)
          : ([-2, 48] as [number, number]);
      const locateMultiplier = 8;
      const targetXY = projection(center as [number, number])!;
      const locateTransform = d3.zoomIdentity
        .translate(width / 2 - targetXY[0] * locateMultiplier, height / 2 - targetXY[1] * locateMultiplier)
        .scale(locateMultiplier);
      const path = d3.geoPath(projection);

      const paths = svg
        .append("g")
        .selectAll<SVGPathElement, Feature<Geometry, MapProperties>>("path")
        .data(countries.features)
        .join("path")
        .attr("d", (datum) => path(datum) ?? "")
        .attr("aria-label", (datum) => datum.properties.name ?? "Unknown country")
        .attr("data-country-code", (datum) => numericCountryIdToIso(datum.id))
        .attr("fill", (datum) => {
          const summary = countrySummaries.get(numericCountryIdToIso(datum.id));
          return summary ? visitedColor() : UNVISITED_FILL;
        })
        .attr("stroke", (datum) =>
          countrySummaries.has(numericCountryIdToIso(datum.id)) ? "#FFB4A8" : "rgba(255,255,255,0.15)",
        )
        .attr("stroke-width", (datum) =>
          countrySummaries.has(numericCountryIdToIso(datum.id)) ? "1.5" : "0.5",
        )
        .attr("filter", (datum) =>
          countrySummaries.has(numericCountryIdToIso(datum.id)) ? "url(#country-glow)" : null,
        )
        .attr("vector-effect", "non-scaling-stroke")
        .attr("paint-order", "stroke")
        .classed("map-region-highlighted", (datum) => countrySummaries.has(numericCountryIdToIso(datum.id)))
        .style("cursor", (datum) => (countrySummaries.has(numericCountryIdToIso(datum.id)) ? "pointer" : "default"))
        .on("mouseover", function (_event, datum) {
          const summary = countrySummaries.get(numericCountryIdToIso(datum.id));
          if (summary) d3.select(this).attr("fill", CORAL_HOVER);
        })
        .on("mouseout", function (_event, datum) {
          const summary = countrySummaries.get(numericCountryIdToIso(datum.id));
          if (summary) d3.select(this).attr("fill", visitedColor());
        })
        .on("mouseenter", (event, datum) => {
          const summary = countrySummaries.get(numericCountryIdToIso(datum.id));
          if (summary) showTooltip(event, datum.properties.name ?? "Unknown country", summary);
        })
        .on("mousemove", (event, datum) => {
          const summary = countrySummaries.get(numericCountryIdToIso(datum.id));
          if (summary) showTooltip(event, datum.properties.name ?? "Unknown country", summary);
        })
        .on("mouseleave", () => setTooltip(null))
        .on("click", (event, datum) => {
          const iso = numericCountryIdToIso(datum.id);
          const summary = countrySummaries.get(iso);
          if (!summary) return;
          showMemoryPopup(event, summary);
          if (iso === "GBR") {
            window.setTimeout(() => transitionToView("uk"), 220);
          }
        });

      installZoom(projection, path, paths, {
        initialTransform: locateTransform,
        homeTransform: locateTransform,
        fullTransform: d3.zoomIdentity,
      });
    }

    if (view === "uk" && ukTopology && !resolvingUkLocations) {
      svg.property("__zoom", d3.zoomIdentity);
      const lads = toFeatureCollection(ukTopology, "lad");
      const projection = d3.geoMercator().fitExtent(
        paddedExtent(width, height, 24),
        lads,
      );
      const path = d3.geoPath(projection);

      const paths = svg
        .append("g")
        .selectAll<SVGPathElement, Feature<Geometry, MapProperties>>("path")
        .data(lads.features)
        .join("path")
        .attr("d", (datum) => path(datum) ?? "")
        .attr("aria-label", (datum) => datum.properties.LAD13NM ?? "Unknown location")
        .attr("data-location", (datum) => ukLadToLocation.get(datum.properties.LAD13NM ?? "") ?? "")
        .attr("fill", (datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          return location && ukSummaries.has(location) ? visitedColor() : UNVISITED_FILL;
        })
        .attr("stroke", (datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          return location && ukSummaries.has(location) ? "#FFB4A8" : "rgba(255,255,255,0.15)";
        })
        .attr("stroke-width", (datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          return location && ukSummaries.has(location) ? "1.5" : "0.4";
        })
        .attr("filter", (datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          return location && ukSummaries.has(location) ? "url(#country-glow)" : null;
        })
        .attr("vector-effect", "non-scaling-stroke")
        .attr("paint-order", "stroke")
        .classed("map-region-highlighted", (datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          return Boolean(location && ukSummaries.has(location));
        })
        .style("cursor", (datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          return location && ukSummaries.has(location) ? "pointer" : "default";
        })
        .on("mouseover", function (_event, datum) {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          const summary = location ? ukSummaries.get(location) : undefined;
          if (summary) d3.select(this).attr("fill", CORAL_HOVER);
        })
        .on("mouseout", function (_event, datum) {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          const summary = location ? ukSummaries.get(location) : undefined;
          if (summary) d3.select(this).attr("fill", visitedColor());
        })
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
        .on("mouseleave", () => setTooltip(null))
        .on("click", (event, datum) => {
          const location = ukLadToLocation.get(datum.properties.LAD13NM ?? "");
          const summary = location ? ukSummaries.get(location) : undefined;
          if (summary) showMemoryPopup(event, summary);
        });

      installZoom(projection, path, paths, {
        initialTransform: d3.zoomIdentity,
        homeTransform: d3.zoomIdentity,
        fullTransform: d3.zoomIdentity,
      });
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

    function showMemoryPopup(event: PointerEvent, summary: LocationSummary) {
      const city = [...summary.cities][0];
      setTooltip(null);
      setMemoryPopup({
        x: event.clientX + 14,
        y: event.clientY + 14,
        city,
        memoryCount: summary.memoryCount,
        memories: [],
        loading: true,
      });
      searchMemory({ query_tags: MAP_SEARCH_TAGS, city, top_k: 2 })
        .then((results) => {
          const returnedCity = normalizeCity(results.find((result) => result.city)?.city) ?? city;
          setMemoryPopup((current) =>
            current && current.city === city
              ? { ...current, city: returnedCity, memories: results, loading: false }
              : current,
          );
        })
        .catch((err: unknown) => {
          console.warn(`[map] Failed to load memories for city="${city}": ${errorMessage(err)}`);
          setMemoryPopup((current) =>
            current && current.city === city ? { ...current, memories: [], loading: false } : current,
          );
        });
    }

    function installZoom(
      projection: d3.GeoProjection,
      path: d3.GeoPath<unknown, Feature<Geometry, MapProperties>>,
      paths: d3.Selection<SVGPathElement, Feature<Geometry, MapProperties>, SVGGElement, unknown>,
      options: {
        initialTransform?: d3.ZoomTransform;
        homeTransform?: d3.ZoomTransform;
        fullTransform?: d3.ZoomTransform;
      } = {},
    ) {
      const baseScale = projection.scale();
      const baseTranslate = projection.translate();
      let lastTap = 0;
      const zoomBehavior = d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([1, 8])
        .on("start", () => {
          svg.style("cursor", "grabbing");
        })
        .on("zoom", (event) => {
          const transform = event.transform;
          projection
            .scale(baseScale * transform.k)
            .translate([
              baseTranslate[0] * transform.k + transform.x,
              baseTranslate[1] * transform.k + transform.y,
            ]);
          paths.attr("d", (datum) => path(datum) ?? "");
        })
        .on("end", () => {
          svg.style("cursor", "grab");
        });

      zoomBehaviorRef.current = zoomBehavior;
      homeTransformRef.current = options.homeTransform ?? d3.zoomIdentity;
      fullWorldTransformRef.current = options.fullTransform ?? d3.zoomIdentity;
      svg
        .style("cursor", "grab")
        .call(zoomBehavior)
        .on("dblclick.zoom", null)
        .on("dblclick.reset", (event) => {
          event.preventDefault();
          resetZoomHome();
        })
        .on("touchend.reset", (event) => {
          const now = Date.now();
          if (now - lastTap < 300) {
            event.preventDefault();
            resetZoomHome();
          }
          lastTap = now;
        });
      svg.call(zoomBehavior.transform, options.initialTransform ?? homeTransformRef.current);
    }
  }, [
    countrySummaries,
    isMobile,
    mapSize,
    resolvingUkLocations,
    ukLadToLocation,
    ukSummaries,
    ukTopology,
    view,
    worldTopology,
  ]);

  return (
    <div className={`atlas-page ${drawerExpanded ? "drawer-expanded" : ""}`}>
      {error && <div className="error-banner">{error}</div>}

      <div
        ref={mapRef}
        className={`atlas-map-card ${mapTransitioning ? "transitioning" : ""}`}
      >
        <div className="atlas-title-pill">
          {view === "uk" && (
            <button type="button" onClick={() => transitionToView("world")} aria-label="Back to world map">
              ←
            </button>
          )}
          <div>
            <h1>Your Atlas</h1>
            <p>Mapping your taste across the world.</p>
          </div>
        </div>
        <svg
          ref={svgRef}
          aria-label={view === "world" ? "World taste map" : "United Kingdom taste map"}
          role="img"
          className="atlas-map-svg"
        />
        {(loading || (view === "uk" && (!ukTopology || resolvingUkLocations))) && (
          <div className="atlas-map-loading">
            Loading map...
          </div>
        )}
        {view === "world" && (
          <div className="atlas-map-actions">
            <button type="button" onClick={resetZoomHome}>
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                <path d="M12 21s7-6.1 7-12A7 7 0 0 0 5 9c0 5.9 7 12 7 12Z" />
                <circle cx="12" cy="9" r="2.4" />
              </svg>
              <span>Locate</span>
            </button>
            <button type="button" onClick={resetZoomWorld}>
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z" />
              </svg>
              <span>World View</span>
            </button>
          </div>
        )}
        {tooltip && (
          <div className="atlas-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
            <div className="atlas-tooltip-title">{tooltip.name}</div>
            <div>{tooltip.memoryCount} {tooltip.memoryCount === 1 ? "memory" : "memories"}</div>
            <div className="atlas-tooltip-muted">
              Top tags: {tooltip.tags.length > 0 ? tooltip.tags.join(", ") : "—"}
            </div>
          </div>
        )}
      </div>

      {memoryPopup && (
        <>
          <div className="atlas-popup-backdrop" onClick={() => setMemoryPopup(null)} />
          <div
            className="atlas-memory-popup"
            style={{ left: memoryPopup.x, top: memoryPopup.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {memoryPopup.loading ? (
              <div className="atlas-popup-empty">Loading memories...</div>
            ) : memoryPopup.memories.length > 0 ? (
              <>
                <div className="atlas-popup-thumbs">
                  {memoryPopup.memories.slice(0, 2).map((memory) => (
                    <MemoryPopupImage
                      key={memory.memory_id}
                      memoryId={memory.memory_id}
                      onOpen={() => {
                        setMemoryPopup(null);
                        setPhotoViewer({
                          memoryId: memory.memory_id,
                          city: normalizeCity(memory.city) ?? memoryPopup.city,
                        });
                      }}
                    />
                  ))}
                </div>
                <div className="atlas-popup-city">{formatCityName(memoryPopup.city)}</div>
                <div className="atlas-popup-count">
                  {memoryPopup.memoryCount} {memoryPopup.memoryCount === 1 ? "memory" : "memories"}
                </div>
              </>
            ) : (
              <div className="atlas-popup-empty">No memories here yet</div>
            )}
          </div>
        </>
      )}

      {photoViewer && (
        <AtlasPhotoViewer
          memoryId={photoViewer.memoryId}
          city={photoViewer.city}
          onClose={() => setPhotoViewer(null)}
        />
      )}

      <section
        className="atlas-drawer"
      >
        <button
          className="atlas-drawer-handle"
          type="button"
          aria-label={drawerExpanded ? "Collapse Atlas drawer" : "Expand Atlas drawer"}
          onTouchStart={handleDrawerTouchStart}
          onTouchMove={handleDrawerTouchMove}
          onTouchEnd={handleDrawerTouchEnd}
        />
        <section className="atlas-stats">
          <StatCard icon="⌖" value={countrySummaries.size} label="Countries" />
          <StatCard icon="◇" value={uniqueCityCount} label="Cities" />
          <StatCard icon="◉" value={memories.length} label="Memories" />
        </section>

        <div className="atlas-drawer-expanded-content">
          <section className="atlas-profile-card">
            <h3>Taste Profile</h3>
            <div className="atlas-profile-bar" aria-label="Taste profile by memory type">
              {tasteProfile.map((segment) => (
                <span
                  key={segment.type}
                  className={`profile-segment profile-${segment.type}`}
                  style={{ width: `${segment.percent}%` }}
                />
              ))}
            </div>
            <div className="atlas-profile-legend">
              {tasteProfile.map((segment) => (
                <span key={segment.type} className="tag-chip profile-chip">
                  <span className={`profile-dot profile-${segment.type}`} />
                  {segment.label} {segment.percent}%
                </span>
              ))}
            </div>
          </section>

          <section className="atlas-coming-soon">
            <div className="atlas-coming-label">Expanding Horizons</div>
            <div className="atlas-coming-chips">
              {COMING_SOON.map((item) => (
                <span key={item} className="tag-chip">🔒 {item}</span>
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function StatCard({ icon, value, label }: { icon: string; value: number; label: string }) {
  return (
    <div className="atlas-stat-card">
      <div className="atlas-stat-icon">{icon}</div>
      <div className="atlas-stat-value">{value}</div>
      <div className="atlas-stat-label">{label}</div>
    </div>
  );
}

function MemoryPopupImage({ memoryId, onOpen }: { memoryId: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const imageUrl = `${MEMORY_SERVICE_BASE_URL}/files/${encodeURIComponent(memoryId)}?variant=thumb`;

  if (failed) {
    return (
      <button className="atlas-popup-thumb-button" type="button" onClick={onOpen}>
        <div className="atlas-popup-placeholder" aria-label="Memory image unavailable">📷</div>
      </button>
    );
  }

  return (
    <button className="atlas-popup-thumb-button" type="button" onClick={onOpen}>
      <img
        src={imageUrl}
        alt={`memory-${memoryId}`}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function AtlasPhotoViewer({ memoryId, city, onClose }: { memoryId: string; city: string; onClose: () => void }) {
  const imageUrl = `${MEMORY_SERVICE_BASE_URL}/files/${encodeURIComponent(memoryId)}?variant=preview`;

  return (
    <div className="atlas-photo-viewer">
      <button className="atlas-photo-back" type="button" onClick={onClose}>
        ← {formatCityName(city)}
      </button>
      <img src={imageUrl} alt={`memory-${memoryId}`} />
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

function transformForFit({
  projectionFactory,
  baseProjection,
  target,
  extent,
}: {
  projectionFactory: () => d3.GeoProjection;
  baseProjection: d3.GeoProjection;
  target: Feature<Geometry, MapProperties> | FeatureCollection<Geometry, MapProperties>;
  extent: [[number, number], [number, number]];
}) {
  const fittedProjection = projectionFactory().fitExtent(extent, target);
  const baseScale = baseProjection.scale();
  const [baseX, baseY] = baseProjection.translate();
  const fittedScale = fittedProjection.scale();
  const [fittedX, fittedY] = fittedProjection.translate();
  const scale = fittedScale / baseScale;
  return d3.zoomIdentity.translate(fittedX - baseX * scale, fittedY - baseY * scale).scale(scale);
}

function paddedExtent(width: number, height: number, padding: number): [[number, number], [number, number]] {
  const safePadding = Math.min(padding, Math.max(0, (width - 1) / 2), Math.max(0, (height - 1) / 2));
  return [
    [safePadding, safePadding],
    [width - safePadding, height - safePadding],
  ];
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

function visitedColor(): string {
  return CORAL;
}

function normalizeVisionType(visionType: string | undefined): "scenery" | "food" | "architecture" | "other" {
  const type = (visionType ?? "").trim().toLowerCase();
  if (type === "scenery" || type === "food" || type === "architecture") return type;
  return "other";
}

function formatCityName(city: string): string {
  return city
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function numericCountryIdToIso(id: string | number | undefined): string {
  const numericId = String(id ?? "").padStart(3, "0");
  return Object.entries(COUNTRY_ISO_TO_NUMERIC).find(([, numeric]) => numeric === numericId)?.[0] ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
