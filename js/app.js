import { DuneSimulation } from "./dune-simulation.js";
import { CameraWindController } from "./camera-controller.js";
import {
  PRESET_GRAINS,
  clamp,
  classifyGrain,
  formatGrainSize,
  getScienceSummary,
  logSliderToMillimeters,
  millimetersToLogSlider,
  thresholdWind,
} from "./science-model.js";

const APP_VERSION = "2.1.0";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  modeButtons: $$('[data-mode]'),
  controlButtons: $$('[data-control]'),
  compareSection: $("#compareSection"),
  detailSection: $("#detailSection"),
  cameraPanel: $("#cameraPanel"),
  manualPanel: $("#manualPanel"),
  cameraStartButton: $("#cameraStartButton"),
  cameraStopButton: $("#cameraStopButton"),
  retryMediaPipeButton: $("#retryMediaPipeButton"),
  cameraVideo: $("#cameraVideo"),
  cameraOverlay: $("#cameraOverlay"),
  cameraStatus: $("#cameraStatus"),
  engineStatus: $("#engineStatus"),
  handDetectionBadge: $("#handDetectionBadge"),
  engineBadge: $("#engineBadge"),
  cameraLiveValue: $("#cameraLiveValue"),
  engineLiveValue: $("#engineLiveValue"),
  manualWindSlider: $("#manualWindSlider"),
  manualWindValue: $("#manualWindValue"),
  directionButtons: $$('[data-direction]'),
  grainSlider: $("#grainSlider"),
  grainSizeValue: $("#grainSizeValue"),
  grainClassValue: $("#grainClassValue"),
  grainPresetButtons: $$('[data-grain-size]'),
  pauseButton: $("#pauseButton"),
  resetButton: $("#resetButton"),
  fullscreenButton: $("#fullscreenButton"),
  observationButton: $("#observationButton"),
  windDirectionValue: $("#windDirectionValue"),
  windStrengthValue: $("#windStrengthValue"),
  windGaugeFill: $("#windGaugeFill"),
  movementValue: $("#movementValue"),
  formationValue: $("#formationValue"),
  thresholdValue: $("#thresholdValue"),
  grainLiveTitle: $("#grainLiveTitle"),
  movementLiveTitle: $("#movementLiveTitle"),
  movementLiveDescription: $("#movementLiveDescription"),
  conclusionLive: $("#conclusionLive"),
  formationMeterFill: $("#formationMeterFill"),
  formationMeterText: $("#formationMeterText"),
  thresholdCanvas: $("#thresholdCanvas"),
  compareCards: $$(".compare-card"),
  detailStats: $("#detailStats"),
  observationBody: $("#observationBody"),
  observationEmpty: $("#observationEmpty"),
  exportCsvButton: $("#exportCsvButton"),
  clearObservationsButton: $("#clearObservationsButton"),
  toast: $("#toast"),
  fatalBanner: $("#fatalBanner"),
};

validateRequiredElements();

const state = {
  mode: "compare",
  control: "hand",
  manualMagnitude: Number(elements.manualWindSlider.value),
  manualDirection: 0,
  handWind: 0,
  paused: false,
  lastFrameTime: performance.now(),
  lastUiUpdate: 0,
  detailGrainSize: 0.25,
  records: loadRecords(),
  cameraRunning: false,
  engine: "none",
  engineState: "neutral",
  resizeScheduled: false,
};

const detailSimulation = new DuneSimulation($("#detailCanvas"), {
  grainSizeMm: state.detailGrainSize,
  label: "선택한 입자",
  compact: false,
  seed: 31,
});

const comparisonSimulations = PRESET_GRAINS.map((preset, index) => {
  const canvas = $(`#compareCanvas-${preset.id}`);
  return new DuneSimulation(canvas, {
    grainSizeMm: preset.sizeMm,
    label: preset.label,
    compact: true,
    seed: 71 + index * 17,
  });
});

const cameraController = new CameraWindController({
  video: elements.cameraVideo,
  overlay: elements.cameraOverlay,
  cameraStatusElement: elements.cameraStatus,
  onWindImpulse: (signedWind, metadata) => {
    if (state.control !== "hand") return;
    const sameDirection = Math.sign(state.handWind) === Math.sign(signedWind);
    const previousMagnitude = Math.abs(state.handWind);
    const incomingMagnitude = Math.abs(signedWind);
    const blendedMagnitude = sameDirection
      ? Math.max(incomingMagnitude, previousMagnitude * 0.72 + incomingMagnitude * 0.28)
      : incomingMagnitude;
    state.handWind = Math.sign(signedWind) * clamp(blendedMagnitude, 0, 10);

    const source = metadata?.engine === "mediapipe" ? "손 관절 인식" : "움직임 감지";
    elements.handDetectionBadge.textContent = `${source} · 바람 발생`;
    elements.handDetectionBadge.dataset.state = "active";
  },
  onTrackingUpdate: ({ detected, open, velocity, engine }) => {
    if (!state.cameraRunning) return;
    if (engine === "mediapipe") {
      elements.handDetectionBadge.textContent = detected
        ? open
          ? "손바닥 인식"
          : "손 인식 · 손가락 펴기"
        : "손을 찾는 중";
      elements.handDetectionBadge.dataset.state = detected ? (open ? "active" : "waiting") : "neutral";
    } else {
      elements.handDetectionBadge.textContent = detected ? "손 움직임 감지" : "움직임을 기다리는 중";
      elements.handDetectionBadge.dataset.state = detected ? "active" : "neutral";
    }
    elements.handDetectionBadge.title = `가로 이동 속도: ${Math.abs(velocity ?? 0).toFixed(2)}`;
  },
  onEngineUpdate: ({ engine, state: engineState, message }) => {
    state.engine = engine;
    state.engineState = engineState;
    elements.engineStatus.textContent = message;
    elements.engineStatus.dataset.state = engineState;
    elements.engineBadge.dataset.state = engineState;

    if (engine === "mediapipe") {
      elements.engineBadge.textContent = "MediaPipe 손 관절 인식";
      elements.engineLiveValue.textContent = "MediaPipe 손 인식";
    } else if (engine === "motion") {
      elements.engineBadge.textContent = engineState === "loading" ? "MediaPipe 준비 중" : "카메라 움직임 감지";
      elements.engineLiveValue.textContent = engineState === "loading" ? "MediaPipe 준비 중" : "움직임 감지(대체)";
    } else {
      elements.engineBadge.textContent = "인식 준비 전";
      elements.engineLiveValue.textContent = "카메라 시작 전";
    }

    const retryAvailable = state.cameraRunning && engine === "motion" && engineState === "fallback";
    elements.retryMediaPipeButton.hidden = !retryAvailable;
  },
});

initialize();

function validateRequiredElements() {
  const missing = Object.entries(elements)
    .filter(([, value]) => value === null || value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`필수 화면 요소를 찾지 못했습니다: ${missing.join(", ")}`);
  }
}

function initialize() {
  state.detailGrainSize = 0.25;
  elements.grainSlider.value = millimetersToLogSlider(state.detailGrainSize).toFixed(2);
  updateGrainControlText();
  bindEvents();
  setMode("compare");
  setControl("hand", { stopCamera: false });
  renderRecords();
  updateInterface(0);
  setupResizeHandling();
  scheduleResize();

  document.documentElement.dataset.appReady = "true";
  window.__DUNE_APP_READY__ = {
    version: APP_VERSION,
    simulations: comparisonSimulations.length + 1,
    cameraFallback: true,
  };

  requestAnimationFrame(animationLoop);
}

function bindEvents() {
  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  elements.controlButtons.forEach((button) => {
    button.addEventListener("click", () => setControl(button.dataset.control));
  });

  elements.cameraStartButton.addEventListener("click", startCamera);
  elements.cameraStopButton.addEventListener("click", stopCamera);
  elements.retryMediaPipeButton.addEventListener("click", retryMediaPipe);

  elements.manualWindSlider.addEventListener("input", () => {
    state.manualMagnitude = Number(elements.manualWindSlider.value);
    elements.manualWindValue.textContent = `${state.manualMagnitude.toFixed(1)} / 10`;
  });

  elements.directionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.manualDirection = Number(button.dataset.direction);
      updateDirectionButtons();
    });
  });

  elements.grainSlider.addEventListener("input", () => {
    state.detailGrainSize = logSliderToMillimeters(elements.grainSlider.value);
    detailSimulation.setGrainSize(state.detailGrainSize, { reset: true });
    updateGrainControlText();
    updateGrainPresetSelection();
    updateInterface(signedWind());
  });

  elements.grainPresetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.detailGrainSize = Number(button.dataset.grainSize);
      elements.grainSlider.value = millimetersToLogSlider(state.detailGrainSize).toFixed(2);
      detailSimulation.setGrainSize(state.detailGrainSize, { reset: true });
      updateGrainControlText();
      updateGrainPresetSelection();
      updateInterface(signedWind());
    });
  });

  elements.pauseButton.addEventListener("click", togglePause);
  elements.resetButton.addEventListener("click", resetSimulations);
  elements.fullscreenButton.addEventListener("click", toggleFullscreen);
  elements.observationButton.addEventListener("click", addObservation);
  elements.exportCsvButton.addEventListener("click", exportCsv);
  elements.clearObservationsButton.addEventListener("click", clearRecords);

  document.addEventListener("keydown", (event) => {
    const tagName = document.activeElement?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tagName)) return;

    if (event.code === "Space") {
      event.preventDefault();
      togglePause();
      return;
    }

    if (state.control === "manual") {
      if (event.key === "ArrowLeft") {
        state.manualDirection = -1;
        updateDirectionButtons();
      } else if (event.key === "ArrowRight") {
        state.manualDirection = 1;
        updateDirectionButtons();
      } else if (event.key === "0" || event.key === "Escape") {
        state.manualDirection = 0;
        updateDirectionButtons();
      }
    }
  });

  document.addEventListener("fullscreenchange", () => {
    elements.fullscreenButton.textContent = document.fullscreenElement ? "전체 화면 나가기" : "전체 화면";
    scheduleResize();
  });

  document.addEventListener("visibilitychange", () => {
    state.lastFrameTime = performance.now();
  });

  window.addEventListener("orientationchange", scheduleResize);
  window.addEventListener("beforeunload", () => cameraController.stop({ disposeModel: true }));
}

function setupResizeHandling() {
  const targets = [
    $(".simulation-panel"),
    $("#compareSection"),
    $("#detailSection"),
    $(".threshold-chart-wrap"),
  ].filter(Boolean);

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(scheduleResize);
    targets.forEach((target) => observer.observe(target));
    window.__DUNE_RESIZE_OBSERVER__ = observer;
  } else {
    window.addEventListener("resize", scheduleResize, { passive: true });
  }

  window.addEventListener("resize", scheduleResize, { passive: true });
  document.fonts?.ready?.then(scheduleResize).catch(() => {});
}

function scheduleResize() {
  if (state.resizeScheduled) return;
  state.resizeScheduled = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      state.resizeScheduled = false;
      resizeVisibleCanvases();
    });
  });
}

function setMode(mode) {
  if (!["compare", "detail"].includes(mode)) return;
  state.mode = mode;
  elements.modeButtons.forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.compareSection.hidden = mode !== "compare";
  elements.detailSection.hidden = mode !== "detail";
  scheduleResize();
  updateInterface(signedWind());
}

function setControl(control, { stopCamera: shouldStopCamera = true } = {}) {
  if (!["hand", "manual"].includes(control)) return;
  state.control = control;
  elements.controlButtons.forEach((button) => {
    const active = button.dataset.control === control;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  elements.cameraPanel.hidden = control !== "hand";
  elements.manualPanel.hidden = control !== "manual";

  if (control === "manual") {
    state.handWind = 0;
    if (shouldStopCamera && state.cameraRunning) stopCamera();
  } else {
    state.manualDirection = 0;
    updateDirectionButtons();
  }
  scheduleResize();
}

async function startCamera() {
  elements.cameraStartButton.disabled = true;
  elements.cameraStartButton.textContent = "카메라 연결 중…";
  try {
    await cameraController.start();
    state.cameraRunning = true;
    elements.cameraLiveValue.textContent = "연결됨";
    elements.cameraStartButton.hidden = true;
    elements.cameraStopButton.hidden = false;
    elements.handDetectionBadge.textContent = "움직임을 기다리는 중";
    elements.handDetectionBadge.dataset.state = "neutral";
    showToast("카메라가 연결되었습니다. 손을 좌우로 움직여 보세요.");
  } catch (error) {
    state.cameraRunning = false;
    elements.cameraLiveValue.textContent = "연결 실패";
    elements.cameraStartButton.hidden = false;
    elements.cameraStopButton.hidden = true;
    elements.retryMediaPipeButton.hidden = true;
    showToast("카메라를 시작하지 못했습니다. 수동 조작으로도 실험할 수 있습니다.", "error");
  } finally {
    elements.cameraStartButton.disabled = false;
    elements.cameraStartButton.textContent = "카메라 시작";
  }
}

function stopCamera() {
  state.cameraRunning = false;
  cameraController.stop();
  state.handWind = 0;
  elements.cameraLiveValue.textContent = "꺼짐";
  elements.cameraStartButton.hidden = false;
  elements.cameraStopButton.hidden = true;
  elements.retryMediaPipeButton.hidden = true;
  elements.handDetectionBadge.textContent = "카메라 꺼짐";
  elements.handDetectionBadge.dataset.state = "neutral";
}

async function retryMediaPipe() {
  if (!state.cameraRunning) return;
  elements.retryMediaPipeButton.disabled = true;
  elements.retryMediaPipeButton.textContent = "다시 연결 중…";
  try {
    await cameraController.retryMediaPipe();
  } finally {
    elements.retryMediaPipeButton.disabled = false;
    elements.retryMediaPipeButton.textContent = "MediaPipe 다시 연결";
  }
}

function signedWind() {
  if (state.control === "manual") {
    return state.manualDirection * state.manualMagnitude;
  }
  return state.handWind;
}

function animationLoop(now) {
  const deltaSeconds = clamp((now - state.lastFrameTime) / 1000, 0, 0.05);
  state.lastFrameTime = now;

  if (state.control === "hand" && !state.paused) {
    state.handWind *= Math.exp(-deltaSeconds * 0.5);
    if (Math.abs(state.handWind) < 0.04) state.handWind = 0;
  }

  const wind = signedWind();
  const activeSimulations = state.mode === "compare" ? comparisonSimulations : [detailSimulation];
  for (const simulation of activeSimulations) {
    simulation.setPaused(state.paused);
    simulation.update(deltaSeconds, wind);
    simulation.draw();
  }

  if (now - state.lastUiUpdate > 100) {
    state.lastUiUpdate = now;
    updateInterface(wind);
  }

  requestAnimationFrame(animationLoop);
}

function updateInterface(wind) {
  const strength = Math.abs(wind);
  const directionText = wind > 0.15 ? "오른쪽 →" : wind < -0.15 ? "← 왼쪽" : "멈춤";
  elements.windDirectionValue.textContent = directionText;
  elements.windStrengthValue.textContent = `${strength.toFixed(1)} / 10`;
  elements.windGaugeFill.style.width = `${clamp(strength * 10, 0, 100)}%`;

  const focusSize = state.mode === "detail" ? state.detailGrainSize : PRESET_GRAINS[1].sizeMm;
  const summary = getScienceSummary(focusSize, wind);
  elements.movementValue.textContent = summary.state.title;
  elements.formationValue.textContent = summary.state.formation;
  elements.thresholdValue.textContent = `${summary.threshold.toFixed(1)} / 10`;

  elements.grainLiveTitle.textContent = `${summary.grain.title} · ${formatGrainSize(focusSize)}`;
  elements.movementLiveTitle.textContent = summary.state.title;
  elements.movementLiveDescription.textContent = summary.state.description;
  elements.conclusionLive.textContent = summary.conclusion;
  elements.formationMeterFill.style.width = `${clamp(summary.score * 100, 0, 100)}%`;
  elements.formationMeterText.textContent = `${Math.round(summary.score * 100)} / 100`;

  updateComparisonCards();
  updateDetailStats();
  drawThresholdChart(wind);
}

function updateComparisonCards() {
  comparisonSimulations.forEach((simulation, index) => {
    const stats = simulation.getStats();
    const card = elements.compareCards[index];
    if (!card) return;
    const movement = $("[data-stat='movement']", card);
    const height = $("[data-stat='height']", card);
    const loss = $("[data-stat='loss']", card);
    const badge = $("[data-stat='formation']", card);
    if (movement) movement.textContent = stats.stateTitle;
    if (height) height.textContent = stats.heightIndex.toFixed(0);
    if (loss) loss.textContent = stats.lostIndex.toFixed(0);
    if (badge) {
      badge.textContent = `사구 형성 ${stats.formation}`;
      badge.dataset.level = stats.formation;
    }
  });
}

function updateDetailStats() {
  const stats = detailSimulation.getStats();
  const values = {
    movement: stats.stateTitle,
    height: `${stats.heightIndex.toFixed(0)} / 100`,
    migration: stats.migrationIndex.toFixed(1),
    loss: stats.lostIndex.toFixed(0),
  };
  Object.entries(values).forEach(([key, value]) => {
    const target = $(`[data-detail-stat='${key}']`, elements.detailStats);
    if (target) target.textContent = value;
  });
}

function updateGrainControlText() {
  const grain = classifyGrain(state.detailGrainSize);
  elements.grainSizeValue.textContent = formatGrainSize(state.detailGrainSize);
  elements.grainClassValue.textContent = grain.title;
}

function updateGrainPresetSelection() {
  elements.grainPresetButtons.forEach((button) => {
    const active = Math.abs(Number(button.dataset.grainSize) - state.detailGrainSize) < 0.0001;
    button.classList.toggle("is-active", active);
  });
}

function updateDirectionButtons() {
  elements.directionButtons.forEach((button) => {
    const active = Number(button.dataset.direction) === state.manualDirection;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function togglePause() {
  state.paused = !state.paused;
  elements.pauseButton.textContent = state.paused ? "계속하기" : "일시 정지";
  elements.pauseButton.setAttribute("aria-pressed", String(state.paused));
  showToast(state.paused ? "시뮬레이션을 멈췄습니다." : "시뮬레이션을 다시 시작했습니다.");
}

function resetSimulations() {
  const targets = state.mode === "compare" ? comparisonSimulations : [detailSimulation];
  targets.forEach((simulation) => simulation.reset());
  showToast("현재 실험을 처음 상태로 되돌렸습니다.");
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      if (!document.documentElement.requestFullscreen) throw new Error("unsupported");
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    showToast("이 브라우저에서는 전체 화면을 사용할 수 없습니다.", "error");
  }
}

function resizeVisibleCanvases() {
  const activePairs = state.mode === "compare"
    ? comparisonSimulations.map((simulation, index) => [
        simulation,
        $(`#compareStage-${PRESET_GRAINS[index].id}`),
      ])
    : [[detailSimulation, $("#detailCanvasStage")]];

  for (const [simulation, stage] of activePairs) {
    if (!stage || stage.offsetParent === null) continue;
    const rect = stage.getBoundingClientRect();
    if (simulation.resize(rect.width, rect.height)) simulation.draw();
  }

  drawThresholdChart(signedWind());
}

function drawThresholdChart(wind) {
  const canvas = elements.thresholdCanvas;
  const wrap = canvas.parentElement;
  if (!wrap || wrap.offsetParent === null) return;
  const rect = wrap.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return;

  const width = Math.max(260, Math.round(rect.width));
  const height = Math.max(205, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const padding = { left: 43, right: 18, top: 20, bottom: 38 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const minLog = Math.log10(0.005);
  const maxLog = Math.log10(5);
  const xFor = (size) =>
    padding.left + ((Math.log10(size) - minLog) / (maxLog - minLog)) * plotWidth;
  const yFor = (value) => padding.top + (1 - value / 10) * plotHeight;

  context.fillStyle = "#f8fbfd";
  context.fillRect(padding.left, padding.top, plotWidth, plotHeight);

  const zones = [
    [0.005, 0.063, "rgba(118, 155, 177, 0.10)"],
    [0.063, 2, "rgba(230, 171, 73, 0.12)"],
    [2, 5, "rgba(112, 92, 76, 0.10)"],
  ];
  zones.forEach(([start, end, color]) => {
    context.fillStyle = color;
    context.fillRect(xFor(start), padding.top, xFor(end) - xFor(start), plotHeight);
  });

  context.strokeStyle = "rgba(44, 71, 87, 0.13)";
  context.lineWidth = 1;
  context.font = "11px system-ui, -apple-system, sans-serif";
  context.fillStyle = "#667b88";
  context.textAlign = "right";
  for (let value = 0; value <= 10; value += 2) {
    const y = yFor(value);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillText(String(value), padding.left - 7, y + 4);
  }

  const xTicks = [0.005, 0.02, 0.063, 0.25, 1, 2, 5];
  context.textAlign = "center";
  xTicks.forEach((size) => {
    const x = xFor(size);
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, height - padding.bottom);
    context.stroke();
    const label = size < 0.1 ? size.toFixed(3).replace(/0+$/, "") : String(size);
    context.fillText(label, x, height - 19);
  });

  context.strokeStyle = "#2f6e8c";
  context.lineWidth = 2.4;
  context.beginPath();
  const samples = 100;
  for (let index = 0; index <= samples; index += 1) {
    const ratio = index / samples;
    const size = 10 ** (minLog + ratio * (maxLog - minLog));
    const x = xFor(size);
    const y = yFor(thresholdWind(size));
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();

  const strength = Math.abs(wind);
  const windY = yFor(strength);
  context.strokeStyle = "rgba(199, 82, 51, 0.86)";
  context.lineWidth = 1.8;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(padding.left, windY);
  context.lineTo(width - padding.right, windY);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#a8442c";
  context.textAlign = "left";
  context.font = "700 11px system-ui, -apple-system, sans-serif";
  context.fillText(`현재 바람 ${strength.toFixed(1)}`, padding.left + 5, Math.max(padding.top + 12, windY - 5));

  const markerSizes = state.mode === "compare"
    ? PRESET_GRAINS.map((item) => item.sizeMm)
    : [state.detailGrainSize];
  markerSizes.forEach((size, index) => {
    const x = xFor(size);
    const y = yFor(thresholdWind(size));
    context.beginPath();
    context.arc(x, y, state.mode === "compare" ? 4.5 : 6, 0, Math.PI * 2);
    context.fillStyle = index === 1 || state.mode === "detail" ? "#e88a2b" : "#334e5f";
    context.fill();
    context.strokeStyle = "white";
    context.lineWidth = 1.5;
    context.stroke();
  });

  context.fillStyle = "#506875";
  context.textAlign = "center";
  context.font = "600 11px system-ui, -apple-system, sans-serif";
  context.fillText("입자 크기(mm, 로그 눈금)", padding.left + plotWidth / 2, height - 3);
  context.save();
  context.translate(12, padding.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText("이동 시작에 필요한 상대 바람", 0, 0);
  context.restore();

  context.font = "700 10px system-ui, -apple-system, sans-serif";
  context.fillStyle = "#667b88";
  context.textAlign = "center";
  context.fillText("아주 작은 입자", (xFor(0.005) + xFor(0.063)) / 2, padding.top + 13);
  context.fillText("모래", (xFor(0.063) + xFor(2)) / 2, padding.top + 13);
  context.fillText("큰 입자", (xFor(2) + xFor(5)) / 2, padding.top + 13);
}

function addObservation() {
  const wind = signedWind();
  const timestamp = new Date();
  const direction = wind > 0.15 ? "오른쪽" : wind < -0.15 ? "왼쪽" : "멈춤";
  const simulations = state.mode === "compare" ? comparisonSimulations : [detailSimulation];

  for (const simulation of simulations) {
    const stats = simulation.getStats();
    state.records.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      savedAt: timestamp.toISOString(),
      mode: state.mode === "compare" ? "세 종류 비교" : "한 종류 관찰",
      label: stats.label,
      sizeMm: stats.grainSizeMm,
      windStrength: Math.abs(wind),
      direction,
      movement: stats.stateTitle,
      formation: stats.formation,
      heightIndex: stats.heightIndex,
      lostIndex: stats.lostIndex,
    });
  }

  state.records = state.records.slice(0, 60);
  saveRecords();
  renderRecords();
  showToast(state.mode === "compare" ? "세 입자의 관찰 결과를 기록했습니다." : "관찰 결과를 기록했습니다.");
}

function renderRecords() {
  elements.observationBody.innerHTML = "";
  elements.observationEmpty.hidden = state.records.length > 0;
  elements.exportCsvButton.disabled = state.records.length === 0;
  elements.clearObservationsButton.disabled = state.records.length === 0;

  state.records.slice(0, 12).forEach((record) => {
    const row = document.createElement("tr");
    const date = new Date(record.savedAt);
    const cells = [
      date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
      record.label,
      formatGrainSize(record.sizeMm),
      `${Number(record.windStrength).toFixed(1)} · ${record.direction}`,
      record.movement,
      record.formation,
      Number(record.heightIndex).toFixed(0),
    ];
    cells.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    elements.observationBody.appendChild(row);
  });
}

function loadRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem("sand-dune-hand-lab-records-v2") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecords() {
  try {
    localStorage.setItem("sand-dune-hand-lab-records-v2", JSON.stringify(state.records));
  } catch {
    showToast("브라우저 저장 공간을 사용할 수 없어 이번 화면에서만 기록을 유지합니다.", "error");
  }
}

function clearRecords() {
  state.records = [];
  saveRecords();
  renderRecords();
  showToast("관찰 기록을 모두 지웠습니다.");
}

function exportCsv() {
  if (state.records.length === 0) return;
  const headers = [
    "기록 시각",
    "실험 모드",
    "입자",
    "입자 크기(mm)",
    "상대 바람 세기",
    "풍향",
    "입자 움직임",
    "사구 형성 가능성",
    "사구 성장 지수",
    "관찰 구역 밖 이동 지수",
  ];
  const rows = state.records.map((record) => [
    new Date(record.savedAt).toLocaleString("ko-KR"),
    record.mode,
    record.label,
    record.sizeMm,
    Number(record.windStrength).toFixed(2),
    record.direction,
    record.movement,
    record.formation,
    Number(record.heightIndex).toFixed(1),
    Number(record.lostIndex).toFixed(1),
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `사구_형성_관찰기록_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

let toastTimer;
function showToast(message, type = "neutral") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.state = type;
  elements.toast.hidden = false;
  requestAnimationFrame(() => elements.toast.classList.add("is-visible"));
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("is-visible");
    setTimeout(() => {
      elements.toast.hidden = true;
    }, 190);
  }, 2700);
}
