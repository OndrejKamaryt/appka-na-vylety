// ── Overpass API – skutečné turistické trasy z OSM ────
const routeCache = {};

async function fetchHikingRoutes(lat, lon) {
    const q = encodeURIComponent(
        `[out:json][timeout:30];
         relation["type"="route"]["route"="hiking"](around:8000,${lat},${lon});
         out body geom;`
    );
    const resp = await fetch(`https://overpass-api.de/api/interpreter?data=${q}`);
    if (!resp.ok) throw new Error("Overpass error");
    const data = await resp.json();

    const COLOUR = { red:"#e05c3a", blue:"#3a7ae0", green:"#4caf87", yellow:"#e9a824" };

    const routes = [];
    for (const rel of data.elements) {
        const coords = [];
        for (const m of (rel.members || [])) {
            if (m.type === "way" && m.geometry) {
                m.geometry.forEach(p => coords.push([p.lat, p.lon]));
            }
        }
        if (coords.length < 4) continue;

        // Délka trasy (haversine)
        let km = 0;
        for (let i = 1; i < coords.length; i++) {
            const R = 6371;
            const dlat = (coords[i][0] - coords[i-1][0]) * Math.PI / 180;
            const dlon = (coords[i][1] - coords[i-1][1]) * Math.PI / 180;
            const a = Math.sin(dlat/2)**2
                + Math.cos(coords[i-1][0]*Math.PI/180) * Math.cos(coords[i][0]*Math.PI/180)
                * Math.sin(dlon/2)**2;
            km += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        }

        const sym  = rel.tags?.["osmc:symbol"] || "";
        const col  = (rel.tags?.colour || sym.split(":")[0] || "").toLowerCase();
        routes.push({
            name:   rel.tags?.name || rel.tags?.ref || "Turistická trasa",
            km:     Math.round(km * 10) / 10,
            color:  COLOUR[col] || "#888888",
            coords,
        });
    }

    routes.sort((a, b) => a.km - b.km);

    // Vyber krátká / střední / dlouhá
    const LABELS = ["Krátká", "Střední", "Dlouhá"];
    const short  = routes.find(r => r.km > 0 && r.km <  7);
    const medium = routes.find(r => r.km >= 5 && r.km < 15 && r !== short);
    const long   = routes.slice().reverse().find(r => r.km >= 10 && r !== short && r !== medium);

    const picks  = [short, medium, long]
        .filter(Boolean)
        .map((r, i) => ({ ...r, label: LABELS[i] }));

    // Záložní: vezmi první 3 pokud nenašel dostatek kategorií
    if (picks.length < Math.min(3, routes.length)) {
        return routes.slice(0, 3).map((r, i) => ({ ...r, label: LABELS[i] }));
    }
    return picks;
}

async function getRoutesForTrip(trip) {
    if (!routeCache[trip.id]) {
        routeCache[trip.id] = await fetchHikingRoutes(trip.lat, trip.lon);
    }
    return routeCache[trip.id];
}

// ── Hlavní aplikace ────────────────────────────────────
(() => {
    let activeCategory = "vse";
    let activeTrip     = null;
    let currentRoutes  = [];
    let markers        = {};
    let miniMap        = null;
    let miniMarker     = null;
    let miniPolyline   = null;

    // ── Mapa ──────────────────────────────────────────
    const CZ_BOUNDS = L.latLngBounds([48.4, 11.9], [51.2, 19.0]);
    const map = L.map("map", {
        center: [49.8, 15.5], zoom: 8,
        minZoom: 8, maxZoom: 16,
        maxBounds: CZ_BOUNDS, maxBoundsViscosity: 1.0,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap | © CARTO",
        subdomains: "abcd", maxZoom: 19,
    }).addTo(map);

    window.addEventListener("load", () => setTimeout(() => map.invalidateSize(), 150));

    // ── Maska ČR ──────────────────────────────────────
    const CZ_FALLBACK = [
        [49.496,18.853],[49.495,18.555],[49.990,18.400],[50.049,17.649],
        [50.362,17.555],[50.474,16.869],[50.216,16.719],[50.423,16.176],
        [50.698,16.239],[50.785,15.491],[51.107,15.017],[51.745,14.607],
        [50.733,13.338],[50.576,12.682],[50.333,12.198],[49.969,12.415],
        [49.547,12.521],[49.307,13.031],[48.877,13.596],[48.555,14.339],
        [48.964,14.901],[49.039,15.253],[48.734,16.030],[48.786,16.499],
        [48.856,17.445],[48.681,17.849],[49.255,18.160],
    ];
    const WORLD = [[85,-180],[85,180],[-85,180],[-85,-180]];
    let maskLayer = null, borderLayer = null;

    function applyMask(shape) {
        if (maskLayer)   map.removeLayer(maskLayer);
        if (borderLayer) map.removeLayer(borderLayer);
        maskLayer  = L.polygon([WORLD, shape], {
            color:"none", fillColor:"#f0ebe0", fillOpacity:1, interactive:false, smoothFactor:1,
        }).addTo(map);
        borderLayer = L.polygon(shape, {
            color:"#8cb89e", weight:2, fill:false, interactive:false, smoothFactor:1,
        }).addTo(map);
    }
    applyMask(CZ_FALLBACK);
    (async () => {
        try {
            const r = await fetch(
                "https://nominatim.openstreetmap.org/search?country=cz&polygon_geojson=1&format=json&limit=1",
                { headers:{ "Accept-Language":"cs" } }
            );
            const d = await r.json();
            const geo = d[0]?.geojson;
            if (!geo) return;
            const raw = geo.type === "MultiPolygon"
                ? geo.coordinates.reduce((a,b) => a[0].length > b[0].length ? a : b)[0]
                : geo.coordinates[0];
            applyMask(raw.map(([lon,lat]) => [lat,lon]));
        } catch {}
    })();

    // ── DOM ───────────────────────────────────────────
    const tripListEl      = document.getElementById("trip-list");
    const detailPanel     = document.getElementById("detail-panel");
    const detailContent   = document.getElementById("detail-content");
    const detailMapyCzBtn = document.getElementById("detail-mapycz-btn");
    const searchInput     = document.getElementById("search");
    const catBtns         = document.querySelectorAll(".cat-btn");

    // ── Marker ────────────────────────────────────────
    function makeIcon(trip, isActive = false) {
        return L.divIcon({
            className: "map-marker-wrap",
            html: `<div class="map-marker${isActive?" active":""}"><span class="map-marker-icon">${trip.icon}</span></div>`,
            iconSize: [42,42], iconAnchor: [21,42], popupAnchor: [0,-42],
        });
    }

    TRIPS.forEach(trip => {
        const marker = L.marker([trip.lat, trip.lon], { icon: makeIcon(trip) })
            .addTo(map)
            .bindTooltip(trip.name, { direction:"top", offset:[0,-34] });
        marker.on("click", () => selectTrip(trip));
        markers[trip.id] = marker;
    });

    // ── Seznam výletů ─────────────────────────────────
    function renderList() {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = TRIPS.filter(t =>
            (activeCategory === "vse" || t.category === activeCategory) &&
            (!q || t.name.toLowerCase().includes(q) || t.region.toLowerCase().includes(q))
        );
        tripListEl.innerHTML = "";
        if (!filtered.length) {
            tripListEl.innerHTML = `<p class="no-results">Žádné výlety nenalezeny.</p>`;
            return;
        }
        filtered.forEach(trip => {
            const diff = DIFF_LABELS[trip.difficulty] || { cls:"", label:trip.difficulty };
            const card = document.createElement("div");
            card.className = `trip-card${trip.id === activeTrip?.id ? " selected" : ""}`;
            card.innerHTML = `
                <div class="trip-icon">${trip.icon}</div>
                <div class="trip-info">
                    <div class="trip-name">${trip.name}</div>
                    <div class="trip-meta">
                        <span>📍 ${trip.region}</span>
                        <span>⏱ ${trip.duration}</span>
                        <span>📏 ${trip.distance}</span>
                    </div>
                </div>
                <span class="diff-badge ${diff.cls}">${diff.label}</span>`;
            card.addEventListener("click", () => selectTrip(trip));
            tripListEl.appendChild(card);
        });
    }

    // ── Výběr výletu ──────────────────────────────────
    function selectTrip(trip) {
        if (activeTrip) markers[activeTrip.id]?.setIcon(makeIcon(activeTrip, false));
        if (activeTrip?.id === trip.id) {
            activeTrip = null; closeDetail(); renderList(); return;
        }
        activeTrip = trip;
        markers[trip.id]?.setIcon(makeIcon(trip, true));
        map.flyTo([trip.lat, trip.lon], 13, { duration:1.2 });
        openDetail(trip);
        renderList();
    }

    // ── Vykreslení trasy na mini-mapě ─────────────────
    function renderRoute(route, idx) {
        if (!miniMap || !route?.coords?.length) return;
        if (miniPolyline) { miniPolyline.remove(); miniPolyline = null; }
        miniPolyline = L.polyline(route.coords, {
            color: route.color, weight:4.5, opacity:0.9,
            lineJoin:"round", lineCap:"round",
        }).addTo(miniMap);
        miniMap.fitBounds(miniPolyline.getBounds(), { padding:[30,30], maxZoom:14 });
        document.querySelectorAll(".route-btn").forEach((b,i) => b.classList.toggle("active", i===idx));
    }

    function showRouteUI(routes) {
        const container = document.querySelector(".route-tabs");
        if (!container) return;
        if (!routes.length) {
            container.innerHTML = `<p class="route-empty">V okolí nebyly nalezeny turistické trasy.</p>`;
            return;
        }
        container.innerHTML = routes.map((r, i) => `
            <button class="route-btn${i===0?" active":""}" data-route-idx="${i}" style="--rc:${r.color}">
                <span class="route-dot"></span>
                <strong>${r.label}</strong>
                <span class="route-name-text">${r.name}</span>
                <span>${r.km} km</span>
            </button>`).join("");
        renderRoute(routes[0], 0);
    }

    // ── Detail panel ──────────────────────────────────
    function openDetail(trip) {
        const diff = DIFF_LABELS[trip.difficulty] || { cls:"", label:trip.difficulty };
        currentRoutes = [];

        detailContent.innerHTML = `
            <div class="detail-header">
                <div class="detail-big-icon">${trip.icon}</div>
                <div class="detail-title-wrap">
                    <div class="detail-title">${trip.name}</div>
                    <div class="detail-region">📍 ${trip.region}</div>
                </div>
            </div>
            <div class="detail-tags">
                <span class="detail-tag">${CATEGORY_LABELS[trip.category]||trip.category}</span>
                <span class="detail-tag diff-badge ${diff.cls}">${diff.label}</span>
            </div>
            <p class="detail-desc">${trip.description}</p>
            <div class="detail-stats">
                <div class="stat"><div class="stat-val">${trip.duration}</div><div class="stat-lbl">Délka</div></div>
                <div class="stat"><div class="stat-val">${trip.distance}</div><div class="stat-lbl">Vzdálenost</div></div>
                <div class="stat"><div class="stat-val">${trip.elevation}</div><div class="stat-lbl">Převýšení</div></div>
            </div>
            <div class="detail-map-label">Trasy v okolí</div>
            <div class="route-tabs"><div class="route-loading">Načítám trasy…</div></div>`;

        detailMapyCzBtn.href = trip.mapyCzUrl;
        detailPanel.classList.remove("hidden");

        const tripId = trip.id;
        setTimeout(() => {
            if (!miniMap) {
                miniMap = L.map("detail-mini-map", {
                    zoomControl:false, attributionControl:false,
                    dragging:true, scrollWheelZoom:true,
                });
                L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
                    subdomains:"abcd", maxZoom:19,
                }).addTo(miniMap);
            }
            miniMap.invalidateSize();
            if (miniMarker) miniMarker.remove();
            miniMarker = L.marker([trip.lat, trip.lon], { icon:makeIcon(trip,true) }).addTo(miniMap);
            miniMap.setView([trip.lat, trip.lon], 13);

            getRoutesForTrip(trip)
                .then(routes => {
                    if (activeTrip?.id !== tripId) return;
                    currentRoutes = routes;
                    showRouteUI(routes);
                })
                .catch(() => {
                    if (activeTrip?.id !== tripId) return;
                    const c = document.querySelector(".route-tabs");
                    if (c) c.innerHTML = `<p class="route-empty">Trasy se nepodařilo načíst.</p>`;
                });
        }, 350);
    }

    function closeDetail() {
        detailPanel.classList.add("hidden");
        if (miniPolyline) { miniPolyline.remove(); miniPolyline = null; }
        if (activeTrip) {
            markers[activeTrip.id]?.setIcon(makeIcon(activeTrip, false));
            activeTrip = null;
        }
        currentRoutes = [];
        renderList();
    }

    document.getElementById("detail-close").addEventListener("click", closeDetail);

    // Přepínání tras
    detailPanel.addEventListener("click", e => {
        const btn = e.target.closest("[data-route-idx]");
        if (!btn || !currentRoutes.length) return;
        renderRoute(currentRoutes[parseInt(btn.dataset.routeIdx)], parseInt(btn.dataset.routeIdx));
    });

    // ── Kategorie ─────────────────────────────────────
    catBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            catBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            activeCategory = btn.dataset.cat;
            TRIPS.forEach(t => {
                const show = activeCategory === "vse" || t.category === activeCategory;
                if (show)  { if (!map.hasLayer(markers[t.id])) markers[t.id]?.addTo(map); }
                else       { if (map.hasLayer(markers[t.id]))  map.removeLayer(markers[t.id]);
                             if (activeTrip?.id === t.id)       closeDetail(); }
            });
            renderList();
        });
    });

    searchInput.addEventListener("input", renderList);
    renderList();
})();
