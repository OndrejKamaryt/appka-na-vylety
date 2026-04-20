(() => {
    // ── State ──────────────────────────────────────────
    let activeCategory = "vse";
    let activeTrip     = null;
    let markers        = {};

    // ── Map init ───────────────────────────────────────
    // Hranice ČR – mapa nepůjde přetáhnout mimo
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

    // ── Maska okolních států ───────────────────────────
    // Zjednodušená hranice ČR [lat, lon] – Natural Earth 110m (~27 bodů)
    const CZ_SHAPE = [
        [49.496,18.853],[49.495,18.555],[49.990,18.400],[50.049,17.649],
        [50.362,17.555],[50.474,16.869],[50.216,16.719],[50.423,16.176],
        [50.698,16.239],[50.785,15.491],[51.107,15.017],[51.745,14.607],
        [50.733,13.338],[50.576,12.682],[50.333,12.198],[49.969,12.415],
        [49.547,12.521],[49.307,13.031],[48.877,13.596],[48.555,14.339],
        [48.964,14.901],[49.039,15.253],[48.734,16.030],[48.786,16.499],
        [48.856,17.445],[48.681,17.849],[49.255,18.160],
    ];
    const WORLD = [[85,-180],[85,180],[-85,180],[-85,-180]];

    // Krémová maska přes vše mimo ČR
    L.polygon([WORLD, CZ_SHAPE], {
        color: "none", fillColor: "#f0ebe0", fillOpacity: 1,
        interactive: false, smoothFactor: 2,
    }).addTo(map);

    // Jemný zelený okraj ČR
    L.polygon(CZ_SHAPE, {
        color: "#8cb89e", weight: 2.5, fill: false,
        interactive: false, smoothFactor: 2,
    }).addTo(map);

    // Pojistka pro případ kdy kontejner nemá správné rozměry při inicializaci
    window.addEventListener("load", () => setTimeout(() => map.invalidateSize(), 150));

    // ── Elements ───────────────────────────────────────
    const tripListEl   = document.getElementById("trip-list");
    const detailPanel  = document.getElementById("detail-panel");
    const detailContent = document.getElementById("detail-content");
    const detailIframe = document.getElementById("detail-iframe");
    const searchInput  = document.getElementById("search");
    const catBtns      = document.querySelectorAll(".cat-btn");

    // ── Marker factory ─────────────────────────────────
    // Jednoduchý kruh bez rotace – Leaflet správně detekuje klik v celém iconSize boxu
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
            .bindTooltip(trip.name, { direction: "top", offset: [0, -34], className: "leaflet-tooltip" });

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
            card.dataset.id = trip.id;
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
        // Deactivate old marker
        if (activeTrip) {
            markers[activeTrip.id]?.setIcon(makeIcon(activeTrip, false));
        }

        // Same trip → close panel
        if (activeTrip?.id === trip.id) {
            activeTrip = null;
            closeDetail();
            renderList();
            return;
        }

        activeTrip = trip;

        // Activate new marker
        markers[trip.id]?.setIcon(makeIcon(trip, true));

        // Fly to location
        map.flyTo([trip.lat, trip.lon], 13, { duration: 1.2 });

        // Show detail panel
        openDetail(trip);
        renderList();
    }

    // ── Detail panel ───────────────────────────────────
    function openDetail(trip) {
        const diff = DIFF_LABELS[trip.difficulty] || { cls: "", label: trip.difficulty };

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
                <div class="stat">
                    <div class="stat-val">${trip.duration}</div>
                    <div class="stat-lbl">Délka</div>
                </div>
                <div class="stat">
                    <div class="stat-val">${trip.distance}</div>
                    <div class="stat-lbl">Vzdálenost</div>
                </div>
                <div class="stat">
                    <div class="stat-val">${trip.elevation}</div>
                    <div class="stat-lbl">Převýšení</div>
                </div>
            </div>
            <div class="detail-map-label">Mapa trasy (Mapy.cz)</div>
        `;

        detailIframe.src = trip.mapyCzUrl;
        detailPanel.classList.remove("hidden");
    }

    function closeDetail() {
        detailPanel.classList.add("hidden");
        detailIframe.src = "";
        if (activeTrip) {
            markers[activeTrip.id]?.setIcon(makeIcon(activeTrip, false));
            activeTrip = null;
        }
        renderList();
    }

    document.getElementById("detail-close").addEventListener("click", closeDetail);

    // ── Category filter ────────────────────────────────
    catBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            catBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            activeCategory = btn.dataset.cat;

            // Show/hide markers
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
