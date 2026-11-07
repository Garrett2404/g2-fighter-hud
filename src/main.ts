import {
  waitForEvenAppBridge,
  EvenAppBridge,
  type AppLocation,
  AppLocationAccuracy,
  CreateStartUpPageContainer,
  DeviceConnectType,
  type DeviceStatus,
  type EvenHubEvent,
  IMU_Report_Data,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ImuReportPace,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import { type Waypoint, angleDiff, formatRange, isValidWaypoint, normalizeDeg } from './hud-math';
import {
  HUD_IMAGE,
  type HudState,
  type LatLon,
  MENU,
  MIN_ALIGN_M,
  alignTarget,
  buildPageLayout,
  hudImageView,
  hudTexts,
  renderHudImage,
} from './hud-display';
import { initPhone } from './phone';

// Used until the phone reports a GPS fix (and permanently in the simulator, which has no location API).
const DEFAULT_POSITION = { lat: 36.9542, lon: -93.9277 };
const STORAGE_WAYPOINTS = 'waypoints';
const STORAGE_SELECTED = 'selectedWaypoint';
const STORAGE_ALIGN_POINT = 'alignPoint';
const MESSAGE_MS = 3000;
const DELETE_CONFIRM_MS = 5000;
const HINT_MS = 10_000;
const SWIPE_COOLDOWN_MS = 300;
const IMU_DEADBAND_DEG = 0.5;
// IMU axes: z = heading, y = pitch, x = roll. Flip a sign if the ladder moves the wrong way on the glasses.
const PITCH_SIGN = 1;
const ROLL_SIGN = 1;

const state: HudState = {
  heading: 0,
  headingAligned: false,
  alignPoint: null,
  pitch: 0,
  roll: 0,
  lat: DEFAULT_POSITION.lat,
  lon: DEFAULT_POSITION.lon,
  gps: 'waiting',
  accuracyM: null,
  speedMps: 0,
  altitudeM: null,
  waypoints: [{ name: 'HOME', ...DEFAULT_POSITION }],
  selected: 0,
  message: '',
  showHints: true,
  glasses: null,
};

let bridge: EvenAppBridge | null = null;
let pageReady = false;
let rendering = false;
let renderQueued = false;
let sentImageKey = '';
const sentText = new Map<number, string>();
let messageTimer: ReturnType<typeof setTimeout> | undefined;
let lastSwipeAt = 0;
let pendingDelete: { waypoint: Waypoint; until: number } | null = null;
// The IMU yaw has an arbitrary zero (no compass); aligning learns the offset to true north.
// Not saved: the zero can change whenever the glasses restart.
let rawYaw = 0;
let headingOffset = 0;

// A phone UI failure (e.g. the map library) must not take the glasses HUD down with it.
const phone = (() => {
  try {
    return initPhone(state, {
      select: selectWaypoint,
      cycle: cycleWaypoint,
      add: addWaypoint,
      rename: renameWaypoint,
      move: moveWaypoint,
      remove: deleteWaypoint,
      markHere: markCurrentPosition,
      nextName: nextMarkName,
      setSimPosition,
      setHeadPose,
      setAlignPoint,
      align: alignHeading,
      resetAlignment,
      simFix,
    });
  } catch (err) {
    console.error('Phone UI failed to start', err);
    return { refresh() {}, recordFix() {} };
  }
})();

async function init() {
  const b = await waitForEvenAppBridge();
  bridge = b;
  await loadSavedWaypoints(b);

  // Subscribe before anything optional can fail, so glasses input always works.
  b.onEvenHubEvent(handleHubEvent);
  b.onAppLocationChanged(applyFix);
  b.onDeviceStatusChanged(applyDeviceStatus);
  b.getDeviceInfo()
    .then((info) => info && applyDeviceStatus(info.status))
    .catch((err) => console.warn('Glasses status unavailable', err));

  const layout = buildPageLayout();
  const created = await b.createStartUpPageContainer(new CreateStartUpPageContainer(layout));
  // After a WebView reload (e.g. during development) the startup page already exists: replace it.
  if (created !== StartUpPageCreateResult.success && !(await b.rebuildPageContainer(new RebuildPageContainer(layout)))) {
    console.error('Could not create the glasses page', created);
    return;
  }
  pageReady = true;
  requestRender();
  setTimeout(() => {
    state.showHints = false;
    requestRender();
  }, HINT_MS);

  // The simulator rejects both of these; the phone sliders stand in for the IMU there.
  try {
    await b.startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 1000, distanceFilter: 1 });
  } catch (err) {
    console.warn('Location API unavailable, using the default position', err);
    if (state.gps === 'waiting') state.gps = 'unavailable';
    requestRender();
  }
  try {
    await b.imuControl(true, ImuReportPace.P200);
  } catch (err) {
    console.warn('IMU unavailable', err);
  }
}

function handleHubEvent(event: EvenHubEvent) {
  const menuItem = event.menuItemClickEvent?.itemID;
  if (menuItem !== undefined) {
    if (menuItem === MENU.delete) {
      armDelete();
      return;
    }
    cancelDelete();
    if (menuItem === MENU.mark) markCurrentPosition();
    else if (menuItem === MENU.next) cycleWaypoint(1);
    else if (menuItem === MENU.prev) cycleWaypoint(-1);
    else if (menuItem === MENU.align) alignHeading();
    return;
  }

  const sys = event.sysEvent;
  if (sys?.imuData) {
    if (sys.eventType === OsEventTypeList.IMU_DATA_REPORT) applyImu(sys.imuData);
    return;
  }
  if (sys?.eventType === OsEventTypeList.LONG_PRESS_EVENT) {
    cancelDelete();
    markCurrentPosition();
    return;
  }

  // Hardware reports taps/swipes on the capture container (textEvent); the simulator uses sysEvent.
  const input = event.textEvent ?? event.listEvent ?? sys;
  if (!input) return;
  switch (input.eventType) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined: // The SDK can normalize CLICK_EVENT (0) to undefined.
      if (!confirmDelete()) cycleWaypoint(1);
      break;
    case OsEventTypeList.SCROLL_TOP_EVENT:
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (Date.now() - lastSwipeAt < SWIPE_COOLDOWN_MS) break;
      lastSwipeAt = Date.now();
      cancelDelete();
      cycleWaypoint(input.eventType === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1);
      break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      cancelDelete();
      void bridge?.shutDownPageContainer(1);
      break;
  }
}

function applyImu(data: IMU_Report_Data) {
  // Track every sample so an align uses the yaw at that instant, even inside the deadband.
  rawYaw = data.z ?? 0;
  const heading = normalizeDeg(rawYaw + headingOffset);
  const pitch = PITCH_SIGN * (data.y ?? 0);
  const roll = ROLL_SIGN * (data.x ?? 0);
  // Ignore sensor jitter so a still head doesn't keep re-sending the HUD image.
  if (
    Math.abs(angleDiff(heading, state.heading)) < IMU_DEADBAND_DEG &&
    Math.abs(pitch - state.pitch) < IMU_DEADBAND_DEG &&
    Math.abs(roll - state.roll) < IMU_DEADBAND_DEG
  ) {
    return;
  }
  state.heading = heading;
  state.pitch = pitch;
  state.roll = roll;
  requestRender();
}

function applyFix(loc: AppLocation) {
  state.lat = loc.latitude;
  state.lon = loc.longitude;
  state.gps = 'live';
  state.accuracyM = loc.accuracy ?? null;
  if (loc.speed != null && loc.speed >= 0) state.speedMps = loc.speed;
  if (loc.altitude != null) state.altitudeM = loc.altitude;
  phone.recordFix(loc.latitude, loc.longitude);
  requestRender();
}

function applyDeviceStatus(status: DeviceStatus) {
  state.glasses = {
    connected: status.connectType === DeviceConnectType.Connected,
    battery: status.batteryLevel ?? null,
  };
  phone.refresh();
}

/** Coalesces state changes: one render pass at a time, and only changed containers are sent. */
function requestRender() {
  phone.refresh();
  if (!bridge || !pageReady) return;
  if (rendering) {
    renderQueued = true;
    return;
  }
  void renderLoop(bridge);
}

async function renderLoop(b: EvenAppBridge) {
  rendering = true;
  try {
    do {
      renderQueued = false;
      await pushImage(b);
      await pushTexts(b);
    } while (renderQueued);
  } catch (err) {
    console.error('HUD render failed', err);
  } finally {
    rendering = false;
  }
}

async function pushImage(b: EvenAppBridge) {
  const view = hudImageView(state);
  const key = JSON.stringify(view);
  if (key === sentImageKey) return;
  sentImageKey = key;
  const result = await b.updateImageRawData(
    new ImageRawDataUpdate({
      containerID: HUD_IMAGE.id,
      containerName: HUD_IMAGE.name,
      imageData: await renderHudImage(view),
    })
  );
  if (result !== ImageRawDataUpdateResult.success) console.warn('HUD image update failed', result);
}

async function pushTexts(b: EvenAppBridge) {
  for (const text of hudTexts(state)) {
    const key = `${text.textColor}|${text.content}`;
    if (sentText.get(text.id) === key) continue;
    sentText.set(text.id, key);
    await b.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: text.id,
        containerName: text.name,
        content: text.content,
        textColor: text.textColor,
      })
    );
  }
}

function flash(message: string, durationMs = MESSAGE_MS) {
  state.message = message;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    state.message = '';
    requestRender();
  }, durationMs);
  requestRender();
}

function nextMarkName(): string {
  const used = state.waypoints.flatMap((wp) => {
    const match = /^P(\d+)$/.exec(wp.name);
    return match ? [Number(match[1])] : [];
  });
  return `P${Math.max(0, ...used) + 1}`;
}

function markCurrentPosition() {
  if (state.gps === 'waiting') {
    flash('NO GPS FIX  ·  CANNOT MARK');
    return;
  }
  const name = nextMarkName();
  state.waypoints.push({ name, lat: state.lat, lon: state.lon });
  if (state.selected < 0) state.selected = 0;
  saveWaypoints();
  flash(`MARKED ${name}   ${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`);
}

function cycleWaypoint(step: number) {
  const count = state.waypoints.length;
  if (count === 0) {
    flash('NO WAYPOINTS  ·  HOLD TO MARK');
    return;
  }
  selectWaypoint((state.selected + step + count) % count);
}

function selectWaypoint(index: number) {
  state.selected = index;
  persist(STORAGE_SELECTED, String(index));
  requestRender();
}

function addWaypoint(waypoint: Waypoint) {
  if (!isValidWaypoint(waypoint)) return;
  state.waypoints.push(waypoint);
  if (state.selected < 0) state.selected = 0;
  saveWaypoints();
  flash(`ADDED ${waypoint.name}`);
}

// Rename/move edit in place so a pending glasses delete still finds the same object.
function renameWaypoint(index: number, name: string) {
  const waypoint = state.waypoints[index];
  if (!waypoint || !name) return;
  waypoint.name = name;
  saveWaypoints();
}

function moveWaypoint(index: number, lat: number, lon: number) {
  const waypoint = state.waypoints[index];
  if (!waypoint) return;
  waypoint.lat = lat;
  waypoint.lon = lon;
  saveWaypoints();
}

/** Only for the simulator, which has no location API. */
function setSimPosition(lat: number, lon: number) {
  if (state.gps !== 'unavailable') return;
  state.lat = lat;
  state.lon = lon;
  requestRender();
}

function setHeadPose(pose: { heading?: number; pitch?: number; roll?: number }) {
  // The yaw slider stands in for the raw IMU yaw, so aligning can be tried in the simulator.
  if (pose.heading !== undefined) {
    rawYaw = pose.heading;
    state.heading = normalizeDeg(rawYaw + headingOffset);
  }
  if (pose.pitch !== undefined) state.pitch = pose.pitch;
  if (pose.roll !== undefined) state.roll = pose.roll;
  requestRender();
}

/** Simulated GPS fix from the alignment sim. Real GPS always wins. */
function simFix(lat: number, lon: number, accuracyM: number | null) {
  if (state.gps === 'live') return;
  state.gps = 'unavailable';
  state.lat = lat;
  state.lon = lon;
  state.accuracyM = accuracyM;
  requestRender();
}

/** Forgets the true-north alignment, as after the glasses restart. */
function resetAlignment() {
  headingOffset = 0;
  state.headingAligned = false;
  state.heading = normalizeDeg(rawYaw);
  requestRender();
}

function setAlignPoint(point: LatLon | null) {
  state.alignPoint = point;
  persist(STORAGE_ALIGN_POINT, point ? JSON.stringify(point) : '');
  requestRender();
}

/** Assumes the wearer is looking straight at the align point: its bearing becomes the heading. */
function alignHeading() {
  if (!state.alignPoint) {
    flash('NO ALIGN POINT  ·  SET ONE ON THE PHONE MAP');
    return;
  }
  const target = alignTarget(state);
  if (!target) {
    flash('NO GPS FIX  ·  CANNOT ALIGN');
    return;
  }
  if (target.distM < MIN_ALIGN_M) {
    flash(`ALIGN POINT TOO CLOSE (${formatRange(target.distM)})`);
    return;
  }
  headingOffset = normalizeDeg(target.bearing - rawYaw);
  state.heading = target.bearing;
  state.headingAligned = true;
  // GPS position error turns into this much bearing error at this distance.
  const errDeg = state.accuracyM ? (Math.atan(state.accuracyM / target.distM) * 180) / Math.PI : null;
  flash(`HDG ALIGNED  ${String(Math.round(target.bearing) % 360).padStart(3, '0')}°${errDeg === null ? '' : `  ±${Math.max(1, Math.round(errDeg))}°`}`);
}

function deleteWaypoint(index: number) {
  state.waypoints.splice(index, 1);
  if (index < state.selected) state.selected--;
  state.selected = Math.min(state.selected, state.waypoints.length - 1);
  saveWaypoints();
}

// Deleting from the glasses needs a confirming tap because there is no undo.
function armDelete() {
  const waypoint = state.waypoints[state.selected];
  if (!waypoint) {
    flash('NO WAYPOINTS TO DELETE');
    return;
  }
  pendingDelete = { waypoint, until: Date.now() + DELETE_CONFIRM_MS };
  flash(`DELETE ${waypoint.name}?  TAP TO CONFIRM`, DELETE_CONFIRM_MS);
}

/** Returns true when the tap was used to confirm a pending delete. */
function confirmDelete(): boolean {
  const waypoint = takePendingDelete();
  if (!waypoint) return false;
  const index = state.waypoints.indexOf(waypoint);
  if (index >= 0) deleteWaypoint(index);
  flash(`DELETED ${waypoint.name}`);
  return true;
}

function cancelDelete() {
  if (takePendingDelete()) flash('DELETE CANCELLED');
}

function takePendingDelete(): Waypoint | null {
  const waypoint = pendingDelete && Date.now() <= pendingDelete.until ? pendingDelete.waypoint : null;
  pendingDelete = null;
  return waypoint;
}

function saveWaypoints() {
  persist(STORAGE_WAYPOINTS, JSON.stringify(state.waypoints));
  persist(STORAGE_SELECTED, String(state.selected));
  requestRender();
}

function persist(key: string, value: string) {
  bridge?.setLocalStorage(key, value).catch((err) => console.warn(`Could not save ${key}`, err));
}

async function loadSavedWaypoints(b: EvenAppBridge) {
  try {
    const saved = await b.getLocalStorage(STORAGE_WAYPOINTS);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) state.waypoints = parsed.filter(isValidWaypoint);
    }
    const selected = parseInt(await b.getLocalStorage(STORAGE_SELECTED), 10);
    // Older versions had no saved selection and steered to the newest waypoint.
    state.selected =
      selected >= 0 && selected < state.waypoints.length ? selected : state.waypoints.length - 1;
    const align = await b.getLocalStorage(STORAGE_ALIGN_POINT);
    if (align) {
      const parsed: unknown = JSON.parse(align);
      if (isValidWaypoint({ name: 'ALIGN', ...(parsed as object) })) state.alignPoint = parsed as LatLon;
    }
  } catch (err) {
    console.warn('Could not load saved waypoints', err);
  }
  phone.refresh();
}

init();
