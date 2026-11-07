import {
  waitForEvenAppBridge,
  EvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ImuReportPace,
  OsEventTypeList,
  AppLocationAccuracy,
} from '@evenrealities/even_hub_sdk';
import {
  Waypoint,
  getDistanceMeters,
  getBearingDeg,
  buildHeadingTape,
} from './hud-math';

let bridge: EvenAppBridge | null = null;
let currentLat = 36.9542;
let currentLon = -93.9277;
let currentSpeedMph = 0;
let currentAltitudeFt = 1300;

let headYaw = 0;
let headPitch = 0;

// Render lock to prevent BLE / Simulator packet flooding
let isRendering = false;
let renderPending = false;

let waypoints: Waypoint[] = [
  { name: 'HOME', lat: 36.9542, lon: -93.9277 },
];

async function init() {
  setupPhoneUI();

  bridge = await waitForEvenAppBridge();

  const saved = await bridge.getLocalStorage('waypoints');
  if (saved) {
    try {
      waypoints = JSON.parse(saved);
      renderWaypointListUI();
    } catch (_) {}
  }

  const layoutProps = {
    containerTotalNum: 5,
    textObject: [
      // 1. Top Scrolling Compass Tape (2 lines, no scrollbar)
      new TextContainerProperty({
        containerID: 1,
        containerName: 'hud_tape',
        xPosition: 140,
        yPosition: 4,
        width: 340,
        height: 60,
        isEventCapture: 0,
        content: 'INITIALIZING...',
      }),
      // 2. Center Lubber Caret & Digital Heading
      new TextContainerProperty({
        containerID: 2,
        containerName: 'hud_hdg_box',
        xPosition: 256,
        yPosition: 62,
        width: 100,
        height: 36,
        isEventCapture: 0,
        content: '^000°',
      }),
      // 3. Left Telemetry Block
      new TextContainerProperty({
        containerID: 3,
        containerName: 'hud_left',
        xPosition: 8,
        yPosition: 100,
        width: 160,
        height: 120,
        isEventCapture: 0,
        content: 'SPD  0.0 MPH\nALT 1300 FT\nPCH   +0°',
      }),
      // 4. Right Telemetry Block
      new TextContainerProperty({
        containerID: 4,
        containerName: 'hud_right',
        xPosition: 400,
        yPosition: 100,
        width: 168,
        height: 120,
        isEventCapture: 0,
        content: 'TGT: HOME',
      }),
      // 5. Bottom Status Bar (Holds event capture)
      new TextContainerProperty({
        containerID: 5,
        containerName: 'hud_bottom',
        xPosition: 138,
        yPosition: 246,
        width: 320,
        height: 38,
        isEventCapture: 1,
        content: 'NAV MODE [TAP TO MARK POS]',
      }),
    ],
  };

  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(layoutProps));
  await bridge.rebuildPageContainer(new RebuildPageContainer(layoutProps));

  await bridge.startAppLocationUpdates({
    accuracy: AppLocationAccuracy.High,
    intervalMs: 1000,
    distanceFilter: 1,
  });

  bridge.onAppLocationChanged((loc) => {
    currentLat = loc.latitude;
    currentLon = loc.longitude;
    if (loc.speed != null && loc.speed >= 0) {
      currentSpeedMph = loc.speed * 2.23694;
    }
    if (loc.altitude != null) {
      currentAltitudeFt = loc.altitude * 3.28084;
    }
    requestHudUpdate();
  });

  await bridge.imuControl(true, ImuReportPace.P200);

  bridge.onEvenHubEvent(async (event) => {
    const sys = event.sysEvent;
    const txt = event.textEvent;

    if (sys?.eventType === OsEventTypeList.IMU_DATA_REPORT && sys.imuData) {
      const y = sys.imuData.y ?? 0;
      const z = sys.imuData.z ?? 0;
      headYaw = ((z % 360) + 360) % 360;
      headPitch = Math.round(y);
      requestHudUpdate();
    }

    const isClick =
      txt?.eventType === OsEventTypeList.CLICK_EVENT ||
      sys?.eventType === OsEventTypeList.CLICK_EVENT;

    if (isClick) {
      await dropPinAtCurrentLocation();
    }
  });

  requestHudUpdate();
}

/** Throttles HUD updates so rapid slider/IMU events never overlap or drop frames */
function requestHudUpdate() {
  updatePhoneTelemetryUI();
  if (isRendering) {
    renderPending = true;
    return;
  }
  renderLoop();
}

async function renderLoop() {
  if (!bridge) return;
  isRendering = true;

  try {
    const hdgStr = Math.round(headYaw).toString().padStart(3, '0');

    // 1. Update Top Tape
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'hud_tape',
        content: buildHeadingTape(headYaw, currentLat, currentLon, waypoints),
      })
    );

    // 2. Update Center Caret & Digital Bearing
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 2,
        containerName: 'hud_hdg_box',
        content: `^${hdgStr}°`,
      })
    );

    if (headPitch >= -20) {
      const pitchSign = headPitch >= 0 ? `+${headPitch}` : `${headPitch}`;
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 3,
          containerName: 'hud_left',
          content: `SPD ${currentSpeedMph.toFixed(1)} MPH\nALT ${Math.round(currentAltitudeFt)} FT\nPCH ${pitchSign}°`,
        })
      );

      const activeWp = waypoints[waypoints.length - 1];
      if (activeWp) {
        const distM = getDistanceMeters(currentLat, currentLon, activeWp.lat, activeWp.lon);
        const brg = Math.round(getBearingDeg(currentLat, currentLon, activeWp.lat, activeWp.lon));
        const distStr = distM >= 1000 ? `${(distM / 1000).toFixed(2)}KM` : `${Math.round(distM)}M`;

        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 4,
            containerName: 'hud_right',
            content: `TGT: ${activeWp.name}\nBRG: ${brg.toString().padStart(3, '0')}°\nRNG: ${distStr}`,
          })
        );
      }
    }
  } finally {
    isRendering = false;
    if (renderPending) {
      renderPending = false;
      renderLoop();
    }
  }
}

async function dropPinAtCurrentLocation(customName?: string) {
  if (bridge) {
    const fix = await bridge.getAppLocation({
      accuracy: AppLocationAccuracy.High,
      timeoutMs: 3000,
    });
    if (fix) {
      currentLat = fix.latitude;
      currentLon = fix.longitude;
    }
  }

  const pinName = customName || `P${waypoints.length}`;
  waypoints.push({ name: pinName, lat: currentLat, lon: currentLon });
  await saveWaypoints();

  if (bridge) {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 5,
        containerName: 'hud_bottom',
        content: `PINNED: ${pinName} (${currentLat.toFixed(4)})`,
      })
    );
  }
  requestHudUpdate();
}

async function saveWaypoints() {
  renderWaypointListUI();
  if (bridge) {
    await bridge.setLocalStorage('waypoints', JSON.stringify(waypoints));
  }
}

function setupPhoneUI() {
  renderWaypointListUI();

  document.getElementById('btn-drop-here')?.addEventListener('click', () => {
    dropPinAtCurrentLocation();
  });

  document.getElementById('btn-add-wp')?.addEventListener('click', async () => {
    const nameEl = document.getElementById('wp-name') as HTMLInputElement;
    const latEl = document.getElementById('wp-lat') as HTMLInputElement;
    const lonEl = document.getElementById('wp-lon') as HTMLInputElement;

    const name = nameEl.value.trim().toUpperCase() || `P${waypoints.length}`;
    const lat = parseFloat(latEl.value);
    const lon = parseFloat(lonEl.value);

    if (!isNaN(lat) && !isNaN(lon)) {
      waypoints.push({ name, lat, lon });
      nameEl.value = '';
      latEl.value = '';
      lonEl.value = '';
      await saveWaypoints();
      requestHudUpdate();
    }
  });

  const yawSlider = document.getElementById('sim-yaw') as HTMLInputElement;
  const pitchSlider = document.getElementById('sim-pitch') as HTMLInputElement;

  yawSlider?.addEventListener('input', () => {
    headYaw = parseInt(yawSlider.value, 10);
    document.getElementById('lbl-yaw')!.textContent = yawSlider.value;
    requestHudUpdate();
  });

  pitchSlider?.addEventListener('input', () => {
    headPitch = parseInt(pitchSlider.value, 10);
    document.getElementById('lbl-pitch')!.textContent = pitchSlider.value;
    requestHudUpdate();
  });
}

function updatePhoneTelemetryUI() {
  const el = document.getElementById('telemetry-readout');
  if (el) {
    el.innerHTML = `POS: ${currentLat.toFixed(5)}, ${currentLon.toFixed(5)}<br/>HDG: ${Math.round(headYaw)}° | PCH: ${headPitch}° | SPD: ${currentSpeedMph.toFixed(1)} MPH`;
  }
}

function renderWaypointListUI() {
  const listEl = document.getElementById('wp-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  waypoints.forEach((wp, idx) => {
    const row = document.createElement('div');
    row.className = 'wp-item';
    row.innerHTML = `<span><strong>${wp.name}</strong> (${wp.lat.toFixed(4)}, ${wp.lon.toFixed(4)})</span>`;

    const delBtn = document.createElement('button');
    delBtn.textContent = 'DEL';
    delBtn.onclick = async () => {
      waypoints.splice(idx, 1);
      await saveWaypoints();
      requestHudUpdate();
    };

    row.appendChild(delBtn);
    listEl.appendChild(row);
  });
}

init();
