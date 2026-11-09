import {
  waitForEvenAppBridge,
  EvenAppBridge,
  type AppLocation,
  AppLocationAccuracy,
  CreateStartUpPageContainer,
  DeviceConnectType,
  type DeviceStatus,
  type EvenHubEvent,
  type IMU_Report_Data,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ImuReportPace,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import { type Waypoint, formatRange, isValidWaypoint, normalizeDeg } from './hud-math';
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
import { HeadTracker, type LevelStep, type Vec3 } from './head-tracker';
import { initPhone } from './phone';

// Used until the phone reports a GPS fix (and permanently in the simulator, which has no location API).
const DEFAULT_POSITION = { lat: 36.9542, lon: -93.9277 };
const STORAGE_WAYPOINTS = 'waypoints';
const STORAGE_SELECTED = 'selectedWaypoint';
const STORAGE_ALIGN_POINT = 'alignPoint';
const STORAGE_HEAD_LEVEL = 'headLevel';
// Right after launch the host can answer '' for keys that are saved, so keep asking this long.
const STORAGE_RETRY_MS = 3000;
const MESSAGE_MS = 3000;
const DELETE_CONFIRM_MS = 5000;
const HINT_MS = 10_000;
const SWIPE_COOLDOWN_MS = 300;
const IMU_DEADBAND_DEG = 0.5;
// The firmware can stop reporting (power saving, backgrounding); restart the IMU after this much silence.
const IMU_WATCHDOG_MS = 5000;
const LEVEL_STEP_MS = 20_000;
// Time to put the phone away and look up when LEVEL is started from the phone.
const PHONE_LEVEL_DELAY_MS = 4000;
// About a slow walk; below this the GPS course is mostly noise.
const TRACK_MIN_MPS = 1;

const state: HudState = {
  heading: 0,
  headingSource: 'none',
  alignPoint: null,
  pitch: 0,
  roll: 0,
  leveled: false,
  levelStep: null,
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
  diag: { imu: 'starting', imuHz: 0, raw: null, frameMs: null, imageFailures: 0 },
};

let bridge: EvenAppBridge | null = null;
let pageReady = false;
// Saves wait for the saved data to load, so they can't overwrite it with defaults.
let storageReady = false;
let rendering = false;
let renderQueued = false;
let sentImageKey = '';
const sentText = new Map<number, string>();
let messageTimer: ReturnType<typeof setTimeout> | undefined;
let levelTimer: ReturnType<typeof setTimeout> | undefined;
let lastSwipeAt = 0;
let pendingDelete: { waypoint: Waypoint; until: number } | null = null;
const head = new HeadTracker();
let lastImuAt = 0;
let imuSamples = 0;
let imuArming = false;
// The exit dialog sends FOREGROUND_ENTER when it opens and FOREGROUND_EXIT when it's cancelled.
let exitDialogOpen = false;

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
      setSimHeading,
      simImu,
      setAlignPoint,
      align: alignHeading,
      level: () => startLevel(PHONE_LEVEL_DELAY_MS),
      resetHeading,
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
  void loadSaved(b);

  // Subscribe before anything optional can fail, so glasses input always works.
  b.onEvenHubEvent(handleHubEvent);
  b.onAppLocationChanged(applyFix);
  b.onDeviceStatusChanged(applyDeviceStatus);
  b.getDeviceInfo()
    .then((info) => info && applyDeviceStatus(info.status))
    .catch((err) => console.warn('Glasses status unavailable', err));

  if (!(await showPage(b, true))) return;
  setTimeout(() => {
    state.showHints = false;
    requestRender();
  }, HINT_MS);
  // Neither waits for the other: a pending location permission prompt must not hold up head tracking.
  void startLocation(b);
  void armImu(b);
  setInterval(() => imuWatchdog(b), 1000);
}

/** Creates the glasses page, or rebuilds it (after a WebView reload or a cancelled exit dialog), and redraws all of it. */
async function showPage(b: EvenAppBridge, create: boolean): Promise<boolean> {
  const layout = buildPageLayout();
  const created =
    create && (await b.createStartUpPageContainer(new CreateStartUpPageContainer(layout))) === StartUpPageCreateResult.success;
  if (!created && !(await b.rebuildPageContainer(new RebuildPageContainer(layout)))) {
    console.error('Could not create the glasses page');
    return false;
  }
  pageReady = true;
  sentImageKey = '';
  sentText.clear();
  requestRender();
  return true;
}

async function startLocation(b: EvenAppBridge) {
  try {
    await b.startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 1000, distanceFilter: 1 });
  } catch (err) {
    // The simulator has no location API.
    console.warn('Location API unavailable, using the default position', err);
    if (state.gps === 'waiting') state.gps = 'unavailable';
    requestRender();
  }
}

/** Starts IMU reporting; `restart` first stops a stream the firmware may have silently dropped. */
async function armImu(b: EvenAppBridge, restart = false) {
  if (imuArming || state.diag.imu === 'none') return;
  imuArming = true;
  try {
    if (restart) await b.imuControl(false);
    // P100 is the fastest pace, about 10 samples a second.
    if (!(await b.imuControl(true, ImuReportPace.P100))) console.warn('The glasses refused to start the IMU');
  } catch (err) {
    // The simulator has no IMU; the phone's test sliders stand in for it.
    console.warn('IMU unavailable', err);
    state.diag.imu = 'none';
  } finally {
    lastImuAt = Date.now();
    imuArming = false;
  }
}

/** Runs once a second: updates the IMU readout and restarts the IMU when its samples stop. */
function imuWatchdog(b: EvenAppBridge) {
  const d = state.diag;
  d.imuHz = imuSamples;
  imuSamples = 0;
  if (d.imu !== 'none' && pageReady && Date.now() - lastImuAt > IMU_WATCHDOG_MS) {
    d.imu = 'silent';
    void armImu(b, true);
  }
  phone.refresh();
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
    else if (menuItem === MENU.level) startLevel();
    return;
  }

  const sys = event.sysEvent;
  // Real glasses don't always tag IMU reports as IMU_DATA_REPORT, and they must never reach the tap handling.
  if (sys?.imuData || sys?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
    if (sys.imuData) onImuData(sys.imuData);
    return;
  }
  switch (sys?.eventType) {
    case OsEventTypeList.LONG_PRESS_EVENT:
      cancelDelete();
      markCurrentPosition();
      return;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      onForeground(true);
      return;
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      onForeground(false);
      return;
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      stopSensors();
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
      exitDialogOpen = true;
      void bridge?.shutDownPageContainer(1);
      break;
  }
}

function onForeground(entered: boolean) {
  const b = bridge;
  if (!b) return;
  if (exitDialogOpen) {
    if (entered) return;
    // Cancelled: the dialog has already cleared the page.
    exitDialogOpen = false;
    void showPage(b, false);
    return;
  }
  if (!entered) return;
  // Back from the background: sensors may have stopped, and the page may need redrawing.
  void startLocation(b);
  void armImu(b, true);
  sentImageKey = '';
  sentText.clear();
  requestRender();
}

/** The app is exiting: stop the sensors so they don't keep running on the glasses and phone. */
function stopSensors() {
  pageReady = false;
  bridge?.imuControl(false).catch((err) => console.warn('Could not stop the IMU', err));
  bridge?.stopAppLocationUpdates().catch((err) => console.warn('Could not stop location updates', err));
}

function onImuData(data: IMU_Report_Data) {
  // Protobuf leaves out zero fields.
  const raw: Vec3 = [data.x ?? 0, data.y ?? 0, data.z ?? 0];
  lastImuAt = Date.now();
  imuSamples++;
  state.diag.imu = 'live';
  state.diag.raw = raw;
  applyReading(raw);
}

/** Test-slider stand-in for the glasses accelerometer; ignored while the real one is reporting. */
function simImu(sample: Vec3) {
  if (state.diag.imu !== 'live') applyReading(sample);
}

function applyReading(sample: Vec3) {
  const completed = head.push(sample, Date.now());
  if (completed) onLevelStep(completed);
  const attitude = head.attitude();
  if (!attitude) return;
  // Ignore sensor jitter so a still head doesn't keep re-sending the HUD image.
  if (
    !completed &&
    Math.abs(attitude.pitch - state.pitch) < IMU_DEADBAND_DEG &&
    Math.abs(attitude.roll - state.roll) < IMU_DEADBAND_DEG
  ) {
    return;
  }
  state.pitch = attitude.pitch;
  state.roll = attitude.roll;
  requestRender();
}

/** Starts the two-pose LEVEL calibration; IMU samples drive it from there. */
function startLevel(delayMs = 0) {
  head.startLevel(Date.now(), delayMs);
  state.levelStep = head.step;
  // The prompt needs the status line.
  clearTimeout(messageTimer);
  state.message = '';
  armLevelTimeout(delayMs);
  requestRender();
}

function armLevelTimeout(extraMs = 0) {
  clearTimeout(levelTimer);
  levelTimer = setTimeout(() => {
    head.cancelLevel();
    state.levelStep = null;
    flash('LEVEL TIMED OUT  ·  TRY AGAIN');
  }, LEVEL_STEP_MS + extraMs);
}

function onLevelStep(completed: LevelStep) {
  state.levelStep = head.step;
  if (completed === 'horizon') {
    armLevelTimeout();
    return;
  }
  clearTimeout(levelTimer);
  state.leveled = true;
  persist(STORAGE_HEAD_LEVEL, head.save());
  flash('HUD LEVELED');
}

function applyFix(loc: AppLocation) {
  state.lat = loc.latitude;
  state.lon = loc.longitude;
  state.gps = 'live';
  state.accuracyM = loc.accuracy ?? null;
  if (loc.speed != null && loc.speed >= 0) state.speedMps = loc.speed;
  if (loc.altitude != null) state.altitudeM = loc.altitude;
  // Nothing on the glasses senses which way the head turns; while moving, the GPS course stands in.
  if (loc.speed != null && loc.speed >= TRACK_MIN_MPS && loc.heading != null && loc.heading >= 0) {
    state.heading = normalizeDeg(loc.heading);
    state.headingSource = 'track';
  } else if (state.headingSource === 'track') {
    state.headingSource = 'held';
  }
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
  const started = performance.now();
  const result = await b.updateImageRawData(
    new ImageRawDataUpdate({
      containerID: HUD_IMAGE.id,
      containerName: HUD_IMAGE.name,
      imageData: await renderHudImage(view),
    })
  );
  state.diag.frameMs = Math.round(performance.now() - started);
  if (result === ImageRawDataUpdateResult.success) {
    sentImageKey = key;
    state.diag.imageFailures = 0;
  } else {
    // Left unrecorded so the next change retries it.
    state.diag.imageFailures++;
    console.warn('HUD image update failed', result);
  }
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

/** The simulator has neither GPS nor a compass; its heading slider stands in for a heading source. */
function setSimHeading(deg: number) {
  state.heading = normalizeDeg(deg);
  state.headingSource = 'sim';
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

/** Forgets the heading, as at launch. */
function resetHeading() {
  state.headingSource = 'none';
  requestRender();
}

function setAlignPoint(point: LatLon | null) {
  state.alignPoint = point;
  persist(STORAGE_ALIGN_POINT, point ? JSON.stringify(point) : '');
  requestRender();
}

/**
 * The glasses can't sense which way the head turns, so this assumes the wearer is facing the align point and
 * holds its bearing as the heading until the GPS track takes over.
 */
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
  state.heading = target.bearing;
  state.headingSource = 'aligned';
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
  if (!storageReady) return;
  bridge?.setLocalStorage(key, value).catch((err) => console.warn(`Could not save ${key}`, err));
}

async function loadSaved(b: EvenAppBridge) {
  const deadline = Date.now() + STORAGE_RETRY_MS;
  const read = async (key: string) => {
    for (;;) {
      const value = await b.getLocalStorage(key);
      if (value || Date.now() >= deadline) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  try {
    const saved = await read(STORAGE_WAYPOINTS);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) state.waypoints = parsed.filter(isValidWaypoint);
    }
    const selected = parseInt(await read(STORAGE_SELECTED), 10);
    // Older versions had no saved selection and steered to the newest waypoint.
    state.selected =
      selected >= 0 && selected < state.waypoints.length ? selected : state.waypoints.length - 1;
    const align = await read(STORAGE_ALIGN_POINT);
    if (align) {
      const parsed: unknown = JSON.parse(align);
      if (isValidWaypoint({ name: 'ALIGN', ...(parsed as object) })) state.alignPoint = parsed as LatLon;
    }
    const level = await read(STORAGE_HEAD_LEVEL);
    if (level && head.restore(level)) state.leveled = true;
  } catch (err) {
    console.warn('Could not load saved data', err);
  }
  storageReady = true;
  requestRender();
}

init();
