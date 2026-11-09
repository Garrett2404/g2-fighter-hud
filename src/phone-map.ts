import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TAPE_HALF_DEG, type HudState } from './hud-display';

export interface MapHandlers {
  onTap(lat: number, lon: number): void;
  onWaypointTap(index: number): void;
  onWaypointDrag(index: number, lat: number, lon: number): void;
  onAlignDrag(lat: number, lon: number): void;
}

// Every tile origin here must also be in the app.json network whitelist.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const LAYERS = [
  {
    name: 'DARK',
    urls: [`${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`],
    attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors',
    maxNativeZoom: 16,
  },
  {
    name: 'TOPO',
    urls: [`${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`],
    attribution: 'Tiles © Esri — Esri, HERE, Garmin, USGS, NGA, © OpenStreetMap contributors',
    maxNativeZoom: 19,
  },
  {
    name: 'SAT',
    urls: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
    attribution: 'Tiles © Esri — Esri, Maxar, Earthstar Geographics',
    maxNativeZoom: 19,
  },
];

const GREEN = '#00ff66';
const DEFAULT_ZOOM = 16;
const TRAIL_STEP_M = 5;
const CONE_RADIUS = 56;

function conePath(radius: number, halfDeg: number): string {
  const x = (radius * Math.sin((halfDeg * Math.PI) / 180)).toFixed(1);
  const y = (-radius * Math.cos((halfDeg * Math.PI) / 180)).toFixed(1);
  return `M0,0 L-${x},${y} A${radius},${radius} 0 0 1 ${x},${y} Z`;
}

// The wedge matches the slice of compass the glasses' heading tape shows.
const SELF_HTML = `<svg class="self-svg" viewBox="-60 -60 120 120" width="120" height="120">
  <path class="self-cone" d="${conePath(CONE_RADIUS, TAPE_HALF_DEG)}"/>
  <circle class="self-dot" r="7"/>
</svg>`;

function waypointIcon(name: string, selected: boolean): L.DivIcon {
  const pin = document.createElement('div');
  pin.className = selected ? 'wp-pin selected' : 'wp-pin';
  const label = document.createElement('span');
  label.textContent = name;
  pin.append(label);
  return L.divIcon({ className: 'wp-icon', html: pin, iconSize: [28, 28], iconAnchor: [14, 14] });
}

export class HudMap {
  private readonly map: L.Map;
  private tiles: L.LayerGroup;
  private layerIndex = 0;
  private readonly self: L.Marker;
  private readonly accuracy: L.Circle;
  private readonly steerLine: L.Polyline;
  private readonly trailLine: L.Polyline;
  private readonly waypointLayer = L.layerGroup();
  private waypointKey = '';
  private readonly alignMarker: L.Marker;
  private alignKey = '';
  private draft: L.CircleMarker | null = null;
  private lastTrailPoint: L.LatLng | null = null;
  private trailM = 0;
  private follow = true;
  private followed: L.LatLng | null = null;

  constructor(el: HTMLElement, private readonly handlers: MapHandlers) {
    this.map = L.map(el, { zoomControl: false, maxZoom: 20 });
    this.map.attributionControl.setPrefix(false);
    this.tiles = this.makeTiles().addTo(this.map);
    this.trailLine = L.polyline([], { color: GREEN, weight: 3, opacity: 0.45, interactive: false }).addTo(this.map);
    this.steerLine = L.polyline([], { color: GREEN, weight: 2, dashArray: '6 8', interactive: false }).addTo(this.map);
    this.accuracy = L.circle([0, 0], { radius: 1, color: GREEN, weight: 1, fillOpacity: 0.08, interactive: false });
    this.waypointLayer.addTo(this.map);
    this.alignMarker = L.marker([0, 0], {
      icon: L.divIcon({ className: 'wp-icon', html: '<div class="align-pin"><span>ALIGN</span></div>', iconSize: [32, 32], iconAnchor: [16, 16] }),
      draggable: true,
      keyboard: false,
      zIndexOffset: 500,
    });
    this.alignMarker.on('dragend', () => {
      const { lat, lng } = this.alignMarker.getLatLng();
      handlers.onAlignDrag(lat, lng);
    });
    this.self = L.marker([0, 0], {
      icon: L.divIcon({ className: 'self-icon', html: SELF_HTML, iconSize: [120, 120], iconAnchor: [60, 60] }),
      interactive: false,
      keyboard: false,
    });

    this.map.on('click', (e: L.LeafletMouseEvent) => handlers.onTap(e.latlng.lat, e.latlng.lng));
    this.map.on('dragstart', () => (this.follow = false));
  }

  get layerName(): string {
    return LAYERS[this.layerIndex].name;
  }

  get trailMeters(): number {
    return this.trailM;
  }

  update(s: HudState) {
    const hasPosition = s.gps !== 'waiting';
    const position = L.latLng(s.lat, s.lon);
    const selected = s.waypoints[s.selected];

    if (hasPosition) {
      this.self.setLatLng(position).addTo(this.map);
      const icon = this.self.getElement();
      icon?.classList.toggle('sim', s.gps === 'unavailable');
      icon?.classList.toggle('no-heading', s.headingSource === 'none');
      const svg = icon?.querySelector<SVGElement>('svg');
      if (svg) svg.style.transform = `rotate(${s.heading}deg)`;
    } else {
      this.self.remove();
    }

    if (s.gps === 'live' && s.accuracyM) {
      this.accuracy.setLatLng(position).setRadius(s.accuracyM).addTo(this.map);
    } else {
      this.accuracy.remove();
    }

    this.syncWaypoints(s);
    const alignKey = s.alignPoint ? `${s.alignPoint.lat},${s.alignPoint.lon}` : '';
    if (alignKey !== this.alignKey) {
      this.alignKey = alignKey;
      if (s.alignPoint) this.alignMarker.setLatLng([s.alignPoint.lat, s.alignPoint.lon]).addTo(this.map);
      else this.alignMarker.remove();
    }
    this.steerLine.setLatLngs(hasPosition && selected ? [position, [selected.lat, selected.lon]] : []);

    if (!this.followed) {
      const start = hasPosition || !selected ? position : L.latLng(selected.lat, selected.lon);
      this.map.setView(start, DEFAULT_ZOOM);
      this.followed = position;
    } else if (this.follow && hasPosition && !position.equals(this.followed)) {
      this.map.panTo(position);
      this.followed = position;
    }
  }

  locate(s: HudState) {
    this.follow = true;
    this.followed = L.latLng(s.lat, s.lon);
    this.map.setView(this.followed, Math.max(this.map.getZoom(), DEFAULT_ZOOM));
  }

  fitAll(s: HudState) {
    const points: L.LatLngTuple[] = s.waypoints.map((wp) => [wp.lat, wp.lon]);
    if (s.gps !== 'waiting') points.push([s.lat, s.lon]);
    if (points.length === 0) return;
    this.follow = false;
    this.map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: DEFAULT_ZOOM });
  }

  focusOn(lat: number, lon: number) {
    this.follow = false;
    this.map.panTo([lat, lon]);
  }

  cycleLayer(): string {
    this.layerIndex = (this.layerIndex + 1) % LAYERS.length;
    this.tiles.remove();
    this.tiles = this.makeTiles().addTo(this.map);
    return this.layerName;
  }

  showDraft(lat: number, lon: number) {
    this.draft ??= L.circleMarker([lat, lon], { radius: 11, color: '#ffffff', weight: 2, fill: false, interactive: false });
    this.draft.setLatLng([lat, lon]).addTo(this.map);
  }

  clearDraft() {
    this.draft?.remove();
  }

  clearTrail() {
    this.trailLine.setLatLngs([]);
    this.lastTrailPoint = null;
    this.trailM = 0;
  }

  addTrailPoint(lat: number, lon: number) {
    const position = L.latLng(lat, lon);
    if (this.lastTrailPoint) {
      const step = this.lastTrailPoint.distanceTo(position);
      if (step < TRAIL_STEP_M) return;
      this.trailM += step;
    }
    this.lastTrailPoint = position;
    this.trailLine.addLatLng(position);
  }

  private makeTiles(): L.LayerGroup {
    const { urls, attribution, maxNativeZoom } = LAYERS[this.layerIndex];
    return L.layerGroup(
      urls.map((url, i) => L.tileLayer(url, { attribution: i === 0 ? attribution : undefined, maxNativeZoom, maxZoom: 20 }))
    );
  }

  private syncWaypoints(s: HudState) {
    const key = JSON.stringify([s.selected, s.waypoints]);
    if (key === this.waypointKey) return;
    this.waypointKey = key;
    this.waypointLayer.clearLayers();
    s.waypoints.forEach((wp, i) => {
      const selected = i === s.selected;
      // Only the selected pin drags, so panning across other pins can't move them.
      const marker = L.marker([wp.lat, wp.lon], {
        icon: waypointIcon(wp.name, selected),
        draggable: selected,
        keyboard: false,
        zIndexOffset: selected ? 1000 : 0,
      });
      marker.on('click', () => this.handlers.onWaypointTap(i));
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        this.handlers.onWaypointDrag(i, lat, lng);
      });
      marker.addTo(this.waypointLayer);
    });
  }
}
