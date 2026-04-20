// ── Definice tras ─────────────────────────────────────
const ROUTE_DEFS = [
    { label: "Krátká",  color: "#4caf87", seeds: [7,  13, 29], nPts: 7  },
    { label: "Střední", color: "#e9a824", seeds: [41, 17, 53], nPts: 9  },
    { label: "Dlouhá",  color: "#e05c3a", seeds: [61, 37, 71], nPts: 11 },
];

// Generátor přibližných smyček v okolí bodu
function mkWaypoints(lat, lon, radiusKm, nPts, seed) {
    const R = 6371;
    let s = (seed * 9301 + 49297) % 233280;
    const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
    const pts = [];
    for (let i = 0; i < nPts; i++) {
        const angle = (i / nPts) * 2 * Math.PI - Math.PI / 2;
        const r = radiusKm * (1 + rand() * 0.38);
        const dlat = (r / R) * (180 / Math.PI) * Math.cos(angle);
        const dlon = (r / R) * (180 / Math.PI) * Math.sin(angle) / Math.cos(lat * Math.PI / 180);
        pts.push([lat + dlat, lon + dlon]);
    }
    pts.push(pts[0]); // uzavřít smyčku
    return pts;
}

(() => {
    // ── State ──────────────────────────────────────────
    let activeCategory = "vse";
    let activeTrip     = null;
    let activeRouteIdx = 0;
    let markers        = {};
    let miniMap        = null;
    let miniMarker     = null;
    let miniPolyline   = null;

    // ── Map init ───────────────────────────────────────
    const CZ_BOUNDS = L.latLngBounds([48.4, 11.9], [51.2, 19.0]);

    const map = L.map("map", {
        center: [49.8, 15.5],
        zoom: 8,
        minZoom: 8,
        maxZoom: 16,
        maxBounds: CZ_BOUNDS,
        maxBoundsViscosity: 1.0,
        zoomControl: true,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> | © <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 19,
    }).addTo(map);

    window.addEventListener("load", () => setTimeout(() => map.invalidateSize(), 150));

    // ── Hranice ČR + maska okolních států ─────────────
    // Záložní zjednodušený polygon (Natural Earth 110m)
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

    let maskLayer  = null;
    let borderLayer = null;

    function applyMask(shape) {
        if (maskLayer)  map.removeLayer(maskLayer);
        if (borderLayer) map.removeLayer(borderLayer);
        maskLayer = L.polygon([WORLD, shape], {
            color: "none", fillColor: "#f0ebe0", fillOpacity: 1,
            interactive: false, smoothFactor: 1,
        }).addTo(map);
        borderLayer = L.polygon(shape, {
            color: "#8cb89e", weight: 2, fill: false,
            interactive: false, smoothFactor: 1,
        }).addTo(map);
    }

    // Nejdřív zobrazí záložní polygon, pak nahradí přesným z OSM
    applyMask(CZ_FALLBACK);

    (async () => {
        try {
            const r = await fetch(
                "https://nominatim.openstreetmap.org/search?country=cz&polygon_geojson=1&format=json&limit=1",
                { headers: { "Accept-Language": "cs" } }
            );
            const d = await r.json();
            const geo = d[0]?.geojson;
            if (!geo) return;
            const raw = geo.type === "MultiPolygon"
                ? geo.coordinates.reduce((a, b) => a[0].length > b[0].length ? a : b)[0]
                : geo.coordinates[0];
            const shape = raw.map(([lon, lat]) => [lat, lon]);
            applyMask(shape);
        } catch(e) { /* zůstane záložní polygon */ }
    })();

    // ── Elements ───────────────────────────────────────
    const tripListEl    = document.getElementById("trip-list");
    const detailPanel   = document.getElementById("detail-panel");
    const detailContent = document.getElementById("detail-content");
    const detailMapyCzBtn = document.getElementById("detail-mapycz-btn");
    const searchInput   = document.getElementById("search");
    const catBtns       = document.querySelectorAll(".cat-btn");

    // ── Marker factory ─────────────────────────────────
    function makeIcon(trip, isActive = false) {
        return L.divIcon({
            className: "map-marker-wrap",
            html: `<div class="map-marker${isActive ? " active" : ""}"><span class="map-marker-icon">${trip.icon}</span></div>`,
            iconSize: [42, 42],
            iconAnchor: [21, 42],
            popupAnchor: [0, -42],
        });
    }

    // ── Add all markers ────────────────────────────────
    TRIPS.forEach(trip => {
        const marker = L.marker([trip.lat, trip.lon], { icon: makeIcon(trip) })
            .addTo(map)
            .bindTooltip(trip.name, { direction: "top", offset: [0, -34] });
        marker.on("click", () => selectTrip(trip));
        markers[trip.id] = marker;
    });

    // ── Render trip list ───────────────────────────────
    function renderList() {
        const query = searchInput.value.trim().toLowerCase();
        const filtered = TRIPS.filter(t => {
            const matchCat  = activeCategory === "vse" || t.category === activeCategory;
            const matchText = !query || t.name.toLowerCase().includes(query) || t.region.toLowerCase().includes(query);
            return matchCat && matchText;
        });

        tripListEl.innerHTML = "";
        if (filtered.length === 0) {
            tripListEl.innerHTML = `<p class="no-results">Žádné výlety nenalezeny.</p>`;
            return;
        }

        filtered.forEach(trip => {
            const diff = DIFF_LABELS[trip.difficulty] || { cls: "", label: trip.difficulty };
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
                <span class="diff-badge ${diff.cls}">${diff.label}</span>
            `;
            card.addEventListener("click", () => selectTrip(trip));
            tripListEl.appendChild(card);
        });
    }

    // ── Select trip ────────────────────────────────────
    function selectTrip(trip) {
        if (activeTrip) markers[activeTrip.id]?.setIcon(makeIcon(activeTrip, false));
        if (activeTrip?.id === trip.id) {
            activeTrip = null;
            closeDetail();
            renderList();
            return;
        }
        activeTrip = trip;
        markers[trip.id]?.setIcon(makeIcon(trip, true));
        map.flyTo([trip.lat, trip.lon], 13, { duration: 1.2 });
        openDetail(trip);
        renderList();
    }

    // ── Vykreslení trasy na mini-mapě ──────────────────
    function renderRoute(trip, idx) {
        if (!miniMap) return;
        activeRouteIdx = idx;
        const def = ROUTE_DEFS[idx];
        const r   = trip.routeRadii[idx];
        const wpts = mkWaypoints(trip.lat, trip.lon, r, def.nPts, def.seeds[idx]);

        if (miniPolyline) { miniPolyline.remove(); miniPolyline = null; }
        miniPolyline = L.polyline(wpts, {
            color: def.color, weight: 4.5, opacity: 0.9,
            lineJoin: "round", lineCap: "round",
        }).addTo(miniMap);

        miniMap.fitBounds(miniPolyline.getBounds(), { padding: [28, 28], maxZoom: 15 });

        // Zvýraznění aktivní záložky
        document.querySelectorAll(".route-btn").forEach((b, i) => {
            b.classList.toggle("active", i === idx);
        });
    }

    // ── Detail panel ───────────────────────────────────
    function openDetail(trip) {
        const diff = DIFF_LABELS[trip.difficulty] || { cls: "", label: trip.difficulty };

        // Route tabs HTML
        const routeTabs = ROUTE_DEFS.map((def, i) => {
            const r    = trip.routeRadii[i];
            const dist = `~${Math.round(r * 6.3)} km`;
            const dur  = i === 0 ? "~1 hod" : i === 1 ? "~2–3 hod" : "~4–6 hod";
            return `<button class="route-btn${i === 0 ? " active" : ""}" data-route-idx="${i}" style="--rc:${def.color}">
                <span class="route-dot"></span>
                <strong>${def.label}</strong>
                <span>${dist} · ${dur}</span>
            </button>`;
        }).join("");

        detailContent.innerHTML = `
            <div class="detail-header">
                <div class="detail-big-icon">${trip.icon}</div>
                <div class="detail-title-wrap">
                    <div class="detail-title">${trip.name}</div>
                    <div class="detail-region">📍 ${trip.region}</div>
                </div>
            </div>
            <div class="detail-tags">
                <span class="detail-tag">${CATEGORY_LABELS[trip.category] || trip.category}</span>
                <span class="detail-tag diff-badge ${diff.cls}">${diff.label}</span>
            </div>
            <p class="detail-desc">${trip.description}</p>
            <div class="detail-stats">
                <div class="stat"><div class="stat-val">${trip.duration}</div><div class="stat-lbl">Délka</div></div>
                <div class="stat"><div class="stat-val">${trip.distance}</div><div class="stat-lbl">Vzdálenost</div></div>
                <div class="stat"><div class="stat-val">${trip.elevation}</div><div class="stat-lbl">Převýšení</div></div>
            </div>
            <div class="detail-map-label">Trasy v okolí</div>
            <div class="route-tabs">${routeTabs}</div>
        `;

        detailMapyCzBtn.href = trip.mapyCzUrl;

        // Panel zobrazíme PRVNÍ
        detailPanel.classList.remove("hidden");
        activeRouteIdx = 0;

        // Mini-mapu inicializujeme až po CSS přechodu
        setTimeout(() => {
            if (!miniMap) {
                miniMap = L.map("detail-mini-map", {
                    zoomControl: false, attributionControl: false,
                    dragging: true, scrollWheelZoom: true,
                });
                L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
                    subdomains: "abcd", maxZoom: 19,
                }).addTo(miniMap);
            }
            miniMap.invalidateSize();
            if (miniMarker) { miniMarker.remove(); miniMarker = null; }
            miniMarker = L.marker([trip.lat, trip.lon], { icon: makeIcon(trip, true) }).addTo(miniMap);
            renderRoute(trip, 0);
        }, 350);
    }

    function closeDetail() {
        detailPanel.classList.add("hidden");
        if (miniPolyline) { miniPolyline.remove(); miniPolyline = null; }
        if (activeTrip) {
            markers[activeTrip.id]?.setIcon(makeIcon(activeTrip, false));
            activeTrip = null;
        }
        renderList();
    }

    // ── Přepínání tras (event delegation) ──────────────
    detailPanel.addEventListener("click", e => {
        const btn = e.target.closest("[data-route-idx]");
        if (!btn || !activeTrip) return;
        renderRoute(activeTrip, parseInt(btn.dataset.routeIdx));
    });

    document.getElementById("detail-close").addEventListener("click", closeDetail);

    // ── Category filter ────────────────────────────────
    catBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            catBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            activeCategory = btn.dataset.cat;
            TRIPS.forEach(t => {
                const show = activeCategory === "vse" || t.category === activeCategory;
                if (show) {
                    if (!map.hasLayer(markers[t.id])) markers[t.id]?.addTo(map);
                } else {
                    if (map.hasLayer(markers[t.id])) map.removeLayer(markers[t.id]);
                    if (activeTrip?.id === t.id) closeDetail();
                }
            });
            renderList();
        });
    });

    // ── Search ─────────────────────────────────────────
    searchInput.addEventListener("input", renderList);

    // ── Init ───────────────────────────────────────────
    renderList();
})();
