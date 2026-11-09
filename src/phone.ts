import {
  ARRIVED_M,
  HEADING_TAG,
  HUD_IMAGE,
  type HeadingSource,
  type HudState,
  type LatLon,
  MIN_ALIGN_M,
  alignTarget,
  buildPageLayout,
  drawHudImage,
  hudImageView,
  hudTexts,
  steerInfo,
} from './hud-display';
import {
  FT_PER_M,
  MAX_NAME_LENGTH,
  MPH_PER_MPS,
  type Waypoint,
  angleDiff,
  cleanName,
  formatDuration,
  formatRange,
  getBearingDeg,
  getDistanceMeters,
  normalizeDeg,
  parseLatLon,
} from './hud-math';
import { readingFor, type Vec3 } from './head-tracker';
import { HudMap } from './phone-map';
import { AlignSim, WORLD_PX_PER_DEG } from './align-sim';
import './phone.css';

export interface PhoneActions {
  select(index: number): void;
  cycle(step: number): void;
  add(waypoint: Waypoint): void;
  rename(index: number, name: string): void;
  move(index: number, lat: number, lon: number): void;
  remove(index: number): void;
  markHere(): void;
  nextName(): string;
  setSimPosition(lat: number, lon: number): void;
  setSimHeading(deg: number): void;
  /** A stand-in accelerometer sample from the test sliders. */
  simImu(sample: Vec3): void;
  setAlignPoint(point: LatLon | null): void;
  align(): void;
  level(): void;
  resetHeading(): void;
  simFix(lat: number, lon: number, accuracyM: number | null): void;
}

export interface PhoneView {
  refresh(): void;
  /** Called for every GPS fix, even while the phone screen is off. */
  recordFix(lat: number, lon: number): void;
}

const DELETE_ARM_MS = 3000;
// Rough stand-in for the glasses' firmware font in the mirror preview.
const MIRROR_FONT = '21px "Helvetica Neue", Helvetica, Arial, sans-serif';
const MIRROR_LINE_PX = 27;
const HEADING_TEXT: Record<HeadingSource, string> = {
  none: 'NO HEADING',
  track: 'GPS TRACK',
  held: 'HELD',
  aligned: 'ALIGNED',
  sim: 'SIMULATED',
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const setText = (id: string, text: string) => (byId(id).textContent = text);
const deg3 = (deg: number) => String(Math.round(normalizeDeg(deg)) % 360).padStart(3, '0');
const signedDeg = (deg: number) => `${deg >= 0 ? '+' : ''}${Math.round(deg)}°`;
const turnText = (turn: number | null) =>
  turn === null ? '—' : Math.abs(turn) < 3 ? 'AHEAD' : `${turn < 0 ? 'L' : 'R'} ${Math.round(Math.abs(turn))}°`;
const gray = (level: number) => {
  const v = Math.round(255 * Math.min(1, Math.max(0, level)));
  return `rgb(${v},${v},${v})`;
};

export function initPhone(state: Readonly<HudState>, actions: PhoneActions): PhoneView {
  const sim = new AlignSim();
  const map = new HudMap(byId('map'), {
    onTap: openSheet,
    onWaypointTap: (i) => actions.select(i),
    onWaypointDrag: (i, lat, lon) => actions.move(i, lat, lon),
    onAlignDrag: (lat, lon) => actions.setAlignPoint({ lat, lon }),
  });

  // ---- Map toolbar and tap-to-place sheet ----
  const layerButton = byId('btn-layer');
  layerButton.textContent = map.layerName;
  layerButton.addEventListener('click', () => (layerButton.textContent = map.cycleLayer()));
  byId('btn-locate').addEventListener('click', () => map.locate(state));
  byId('btn-fit').addEventListener('click', () => map.fitAll(state));

  const sheet = byId('map-sheet');
  const sheetName = byId<HTMLInputElement>('sheet-name');
  sheetName.maxLength = MAX_NAME_LENGTH;
  let draft: { lat: number; lon: number } | null = null;

  function openSheet(lat: number, lon: number) {
    draft = { lat, lon };
    map.showDraft(lat, lon);
    let where = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    if (state.gps !== 'waiting') {
      const dist = getDistanceMeters(state.lat, state.lon, lat, lon);
      where += `  ·  ${formatRange(dist)} at ${deg3(getBearingDeg(state.lat, state.lon, lat, lon))}°`;
    }
    setText('sheet-coords', where);
    sheetName.placeholder = actions.nextName();
    byId('sheet-sim').hidden = state.gps !== 'unavailable' && !sim.running;
    sheet.hidden = false;
  }

  function closeSheet() {
    draft = null;
    sheet.hidden = true;
    sheetName.value = '';
    map.clearDraft();
  }

  byId('sheet-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (draft) actions.add({ name: cleanName(sheetName.value) || actions.nextName(), ...draft });
    closeSheet();
  });
  byId('sheet-sim').addEventListener('click', () => {
    if (draft && sim.running) sim.truePos = { ...draft };
    else if (draft) actions.setSimPosition(draft.lat, draft.lon);
    closeSheet();
  });
  byId('sheet-align').addEventListener('click', () => {
    if (draft) actions.setAlignPoint(draft);
    closeSheet();
  });
  byId('sheet-cancel').addEventListener('click', closeSheet);

  // ---- Heading align ----
  byId('btn-align').addEventListener('click', () => actions.align());
  byId('btn-align-clear').addEventListener('click', () => actions.setAlignPoint(null));

  function renderAlign() {
    const target = alignTarget(state);
    let info = 'No align point. Tap a distant landmark on the map and choose “Set as align point”.';
    if (state.alignPoint && !target) info = 'Waiting for a GPS fix.';
    else if (target) {
      const where = `${formatRange(target.distM)} at ${deg3(target.bearing)}°`;
      if (target.distM < MIN_ALIGN_M) info = `${where} — too close, pick something farther away.`;
      else {
        const err = state.accuracyM ? (Math.atan(state.accuracyM / target.distM) * 180) / Math.PI : null;
        info = err === null ? where : `${where}  ·  about ±${Math.max(1, Math.round(err))}° from GPS error`;
      }
    }
    setText('align-info', info);
    const status = byId('align-status');
    status.textContent = HEADING_TEXT[state.headingSource];
    status.className = `count ${state.headingSource === 'none' ? 'warn' : 'ok'}`;
    byId('btn-align-clear').hidden = !state.alignPoint;
  }

  // ---- Head tracking: LEVEL and sensor health ----
  byId('btn-level').addEventListener('click', () => actions.level());

  function renderLevel() {
    const status = byId('level-status');
    status.textContent = state.levelStep ? 'LEVELING' : state.leveled ? 'LEVELED' : 'NOT LEVELED';
    status.className = `count ${state.leveled && !state.levelStep ? 'ok' : 'warn'}`;
    const d = state.diag;
    const imu = {
      starting: 'IMU: waiting for the glasses…',
      live: `IMU: live, ${d.imuHz}/s`,
      silent: 'IMU: no samples, restarting it…',
      none: 'IMU: none here (simulator), use the test sliders',
    }[d.imu];
    const raw = d.raw ? `  ·  x ${d.raw[0].toFixed(3)}  y ${d.raw[1].toFixed(3)}  z ${d.raw[2].toFixed(3)}` : '';
    setText('imu-info', imu + raw);
    setText(
      'link-info',
      d.imageFailures > 0
        ? `HUD image: ${d.imageFailures} failed sends in a row`
        : `HUD image: ${d.frameMs === null ? '—' : `${d.frameMs} ms per frame`}`
    );
  }

  // ---- Steering, marking, trail ----
  byId('btn-prev').addEventListener('click', () => actions.cycle(-1));
  byId('btn-next').addEventListener('click', () => actions.cycle(1));
  byId('btn-mark').addEventListener('click', () => actions.markHere());
  byId('btn-trail-clear').addEventListener('click', () => {
    map.clearTrail();
    refresh();
  });

  // ---- Add by coordinates ----
  const coordName = byId<HTMLInputElement>('coord-name');
  coordName.maxLength = MAX_NAME_LENGTH;
  byId('coord-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = byId<HTMLInputElement>('coord-text');
    const point = parseLatLon(text.value);
    if (!point) {
      setText('coord-error', 'No latitude/longitude found. Try "36.9542, -93.9277" or paste a map link.');
      return;
    }
    setText('coord-error', '');
    actions.add({ name: cleanName(coordName.value) || actions.nextName(), ...point });
    coordName.value = '';
    text.value = '';
    map.focusOn(point.lat, point.lon);
  });

  // ---- Simulator head-pose sliders ----
  const bindSlider = (inputId: string, labelId: string, apply?: (value: number) => void) => {
    const input = byId<HTMLInputElement>(inputId);
    input.addEventListener('input', () => {
      setText(labelId, input.value);
      apply?.(Number(input.value));
    });
    return input;
  };
  const yawInput = bindSlider('sim-yaw', 'lbl-yaw', (heading) => {
    // In the alignment sim the slider is where the head really points, which nothing on the glasses senses.
    if (sim.running) sim.trueHeading = heading;
    else actions.setSimHeading(heading);
  });
  const pitchInput = bindSlider('sim-pitch', 'lbl-pitch');
  const rollInput = bindSlider('sim-roll', 'lbl-roll');
  const simPanel = byId<HTMLDetailsElement>('sim-panel');

  // ---- Realistic alignment sim ----
  const SIM_TICK_MS = 100;
  const SIM_GPS_MS = 1000;
  let lastFixAt = 0;

  function setTrueHeading(deg: number) {
    const value = Math.round(normalizeDeg(deg));
    sim.trueHeading = normalizeDeg(deg);
    yawInput.value = String(value);
    setText('lbl-yaw', String(value));
  }

  // While the test panel is open (or the sim runs), the pitch and roll sliders drive a stand-in accelerometer
  // at the real one's rate, so LEVEL works the same way as on the glasses.
  setInterval(() => {
    if (!simPanel.open && !sim.running) return;
    const pitch = Number(pitchInput.value);
    const roll = Number(rollInput.value);
    actions.simImu(sim.running ? sim.reading(pitch, roll) : readingFor(pitch, roll));
    if (!sim.running) return;
    const now = performance.now();
    if (now - lastFixAt >= SIM_GPS_MS) {
      lastFixAt = now;
      const fix = sim.nextFix();
      actions.simFix(fix.lat, fix.lon, sim.gpsErrorM);
    }
    refresh();
  }, SIM_TICK_MS);

  const startButton = byId('btn-sim-start');
  startButton.addEventListener('click', () => {
    if (sim.running) {
      sim.stop();
      actions.simFix(sim.truePos.lat, sim.truePos.lon, null);
    } else {
      sim.start({ lat: state.lat, lon: state.lon }, Number(yawInput.value));
      lastFixAt = 0;
    }
    actions.resetHeading();
    startButton.textContent = sim.running ? 'STOP SIM' : 'START SIM';
    mirror.classList.toggle('sim-world', sim.running);
    refresh();
  });
  bindSlider('sim-gpserr', 'lbl-gpserr', (v) => (sim.gpsErrorM = v));

  function renderSim() {
    if (!sim.running) {
      setText('sim-truth', '');
      return;
    }
    const errText = (err: number) => (Math.abs(err) < 0.5 ? '0°' : `${err > 0 ? '+' : '−'}${Math.abs(err).toFixed(1)}°`);
    const hdg =
      state.headingSource === 'none'
        ? 'HUD HAS NO HEADING'
        : `HUD SAYS ${deg3(state.heading)}°  ·  ERROR ${errText(angleDiff(state.heading, sim.trueHeading))}`;
    const pitchErr = errText(state.pitch - Number(pitchInput.value));
    setText('sim-truth', `REALLY FACING ${deg3(sim.trueHeading)}°  ·  ${hdg}  ·  PITCH ERROR ${pitchErr}`);
  }

  // ---- Waypoint list ----
  const list = byId('wp-list');
  let listKey = '';
  let editing = -1;

  function metaText(wp: Waypoint): string {
    if (state.gps === 'waiting') return `${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}`;
    const dist = getDistanceMeters(state.lat, state.lon, wp.lat, wp.lon);
    if (dist < ARRIVED_M) return 'YOU ARE HERE';
    return `${formatRange(dist)}  ·  ${deg3(getBearingDeg(state.lat, state.lon, wp.lat, wp.lon))}°`;
  }

  function waypointRow(wp: Waypoint, i: number): HTMLElement {
    const row = el('div', i === state.selected ? 'wp-row selected' : 'wp-row');
    const main = el('button', 'wp-main');
    main.type = 'button';
    const meta = el('span', 'wp-meta', metaText(wp));
    meta.dataset.meta = String(i);
    main.append(el('span', 'wp-name', wp.name), meta);
    main.addEventListener('click', () => {
      actions.select(i);
      map.focusOn(wp.lat, wp.lon);
    });

    const rename = el('button', 'icon-btn', '✎');
    rename.type = 'button';
    rename.title = 'Rename';
    rename.addEventListener('click', () => {
      editing = i;
      renderList();
    });

    // Two taps to delete; there's no undo.
    const remove = el('button', 'icon-btn danger', '✕');
    remove.type = 'button';
    remove.title = 'Delete';
    remove.addEventListener('click', () => {
      if (remove.classList.contains('armed')) {
        actions.remove(i);
        return;
      }
      remove.classList.add('armed');
      remove.textContent = 'DELETE?';
      setTimeout(() => {
        remove.classList.remove('armed');
        remove.textContent = '✕';
      }, DELETE_ARM_MS);
    });

    row.append(main, rename, remove);
    return row;
  }

  function editRow(wp: Waypoint, i: number): HTMLElement {
    const row = el('form', 'wp-row editing');
    const input = el('input', 'wp-input');
    input.value = wp.name;
    input.maxLength = MAX_NAME_LENGTH;
    input.autocapitalize = 'characters';
    input.setAttribute('aria-label', 'Waypoint name');
    const save = el('button', 'icon-btn', '✓');
    save.type = 'submit';
    save.title = 'Save name';
    const cancel = el('button', 'icon-btn', '↩');
    cancel.type = 'button';
    cancel.title = 'Cancel';

    row.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = cleanName(input.value);
      editing = -1;
      if (name && name !== wp.name) actions.rename(i, name);
      else renderList();
    });
    cancel.addEventListener('click', () => {
      editing = -1;
      renderList();
    });
    row.append(input, save, cancel);
    requestAnimationFrame(() => input.focus());
    return row;
  }

  function renderList() {
    const key = JSON.stringify([state.selected, state.waypoints, editing]);
    if (key !== listKey) {
      listKey = key;
      if (state.waypoints.length === 0) {
        list.replaceChildren(el('p', 'empty', 'No waypoints yet. Tap the map or mark your position.'));
      } else {
        list.replaceChildren(...state.waypoints.map((wp, i) => (i === editing ? editRow(wp, i) : waypointRow(wp, i))));
      }
      setText('wp-count', String(state.waypoints.length));
    }
    // Distances change with every fix; update them without rebuilding rows mid-tap.
    list.querySelectorAll<HTMLElement>('[data-meta]').forEach((meta) => {
      const wp = state.waypoints[Number(meta.dataset.meta)];
      if (wp) meta.textContent = metaText(wp);
    });
  }

  // ---- Glasses mirror ----
  const mirror = byId<HTMLCanvasElement>('mirror');
  const mirrorCtx = mirror.getContext('2d');
  const imageCanvas = Object.assign(document.createElement('canvas'), { width: HUD_IMAGE.w, height: HUD_IMAGE.h });
  const imageCtx = imageCanvas.getContext('2d');
  const textBoxes = buildPageLayout().textObject ?? [];

  // In the sim, dragging the glasses view turns the head, like grabbing the scenery.
  let drag: { x: number; heading: number } | null = null;
  mirror.addEventListener('pointerdown', (e) => {
    if (!sim.running) return;
    drag = { x: e.clientX, heading: sim.trueHeading };
    mirror.setPointerCapture(e.pointerId);
  });
  mirror.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const canvasPx = ((e.clientX - drag.x) * mirror.width) / mirror.getBoundingClientRect().width;
    setTrueHeading(drag.heading - canvasPx / WORLD_PX_PER_DEG);
  });
  const endDrag = () => (drag = null);
  mirror.addEventListener('pointerup', endDrag);
  mirror.addEventListener('pointercancel', endDrag);

  function drawMirror() {
    if (!mirrorCtx || !imageCtx) return;
    const ctx = mirrorCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mirror.width, mirror.height);
    // The real horizon follows the true head pitch, not the HUD's estimate of it.
    if (sim.running) sim.drawWorld(ctx, state.alignPoint, Number(pitchInput.value));
    drawHudImage(imageCtx, hudImageView(state));
    // The display adds light on top of the world, so the HUD's black background is see-through.
    ctx.globalCompositeOperation = 'lighten';
    ctx.drawImage(imageCanvas, HUD_IMAGE.x, HUD_IMAGE.y);
    ctx.globalCompositeOperation = 'source-over';

    const live = new Map(hudTexts(state).map((t) => [t.id, t]));
    ctx.font = MIRROR_FONT;
    ctx.textBaseline = 'top';
    for (const box of textBoxes) {
      const x = box.xPosition ?? 0;
      const y = box.yPosition ?? 0;
      const w = box.width ?? 0;
      const h = box.height ?? 0;
      const border = box.borderWidth ?? 0;
      if (border) {
        ctx.strokeStyle = gray((box.borderColor ?? 0) / 15);
        ctx.lineWidth = border;
        ctx.strokeRect(x + border / 2, y + border / 2, w - border, h - border);
      }
      const text = live.get(box.containerID ?? -1);
      const inset = border + (box.paddingLength ?? 0);
      ctx.fillStyle = gray((text?.textColor ?? box.textColor ?? 4) / 4);
      (text?.content ?? box.content ?? '').split('\n').forEach((line, row) => {
        ctx.fillText(line, x + inset, y + inset + row * MIRROR_LINE_PX, w - 2 * inset);
      });
    }
  }

  // ---- Live readouts ----
  function renderStatus() {
    const gps = byId('pill-gps');
    gps.className = `pill ${state.gps}`;
    const accuracy = state.accuracyM ? ` ±${Math.round(state.accuracyM * FT_PER_M)} FT` : '';
    gps.textContent = { live: `GPS${accuracy}`, waiting: 'NO GPS FIX', unavailable: 'SIM POSITION' }[state.gps];

    const glasses = byId('pill-glasses');
    const status = state.glasses;
    glasses.className = `pill ${status === null ? '' : status.connected ? 'live' : 'off'}`;
    glasses.textContent =
      status === null ? 'G2 —' : status.connected ? `G2${status.battery === null ? '' : ` ${status.battery}%`}` : 'G2 OFFLINE';
  }

  function renderSteer() {
    const info = steerInfo(state);
    const noFix = state.gps === 'waiting';
    const arrived = info !== null && info.distM < ARRIVED_M;
    setText('steer-name', info ? info.waypoint.name : 'NO WAYPOINT');
    setText('steer-index', info ? `${info.index + 1} of ${info.count}` : 'Tap the map to add one');
    setText('steer-range', !info || noFix ? '—' : formatRange(info.distM));
    setText('steer-brg', !info || noFix || arrived ? '—' : `${deg3(info.bearing)}°`);
    setText('steer-turn', !info || noFix ? '—' : arrived ? 'ARRIVED' : turnText(info.turn));
    setText('steer-ete', info?.eteS != null && !noFix ? formatDuration(info.eteS) : '--:--');
  }

  function renderTelemetry() {
    const live = state.gps === 'live';
    setText('t-gs', live ? (state.speedMps * MPH_PER_MPS).toFixed(1) : '—');
    setText('t-alt', live && state.altitudeM !== null ? String(Math.round(state.altitudeM * FT_PER_M)) : '—');
    setText('t-hdg', state.headingSource === 'none' ? '—' : `${deg3(state.heading)}° ${HEADING_TAG[state.headingSource]}`);
    setText('t-pitch', signedDeg(state.pitch));
    setText('t-roll', signedDeg(state.roll));
    setText('t-pos', `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`);
  }

  function render() {
    renderStatus();
    renderSteer();
    renderTelemetry();
    renderAlign();
    renderLevel();
    renderSim();
    drawMirror();
    map.update(state);
    renderList();
    setText('trail-info', `${formatRange(map.trailMeters)} logged this session`);
  }

  // Head-tracking can update many times a second; draw at most once per frame.
  let frame = 0;
  function refresh() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  render();
  return { refresh, recordFix: (lat, lon) => map.addTrailPoint(lat, lon) };
}
