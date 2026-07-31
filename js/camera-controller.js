import { MotionAnalyzer, clamp } from "./motion-analyzer.js";

const MEDIAPIPE_SOURCES = Object.freeze([
  {
    label: "jsDelivr 1.0.0",
    moduleUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/vision_bundle.mjs",
    wasmUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/wasm",
  },
  {
    label: "jsDelivr 0.10.22",
    moduleUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs",
    wasmUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm",
  },
]);

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const HAND_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]);

function distance(a, b) {
  return Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
}

function averageLandmarks(landmarks, indices) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const index of indices) {
    x += landmarks[index]?.x ?? 0;
    y += landmarks[index]?.y ?? 0;
    z += landmarks[index]?.z ?? 0;
  }
  return { x: x / indices.length, y: y / indices.length, z: z / indices.length };
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function resolveMediaPipeApi(moduleNamespace) {
  const candidates = [
    moduleNamespace,
    moduleNamespace?.default,
    moduleNamespace?.default?.default,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.FilesetResolver && candidate.HandLandmarker) {
      return {
        FilesetResolver: candidate.FilesetResolver,
        HandLandmarker: candidate.HandLandmarker,
      };
    }
  }
  throw new Error("MediaPipe 모듈에서 HandLandmarker를 찾지 못했습니다.");
}

export class CameraWindController {
  constructor({
    video,
    overlay,
    cameraStatusElement,
    onWindImpulse,
    onTrackingUpdate,
    onEngineUpdate,
  }) {
    this.video = video;
    this.overlay = overlay;
    this.overlayContext = overlay.getContext("2d");
    this.cameraStatusElement = cameraStatusElement;
    this.onWindImpulse = onWindImpulse;
    this.onTrackingUpdate = onTrackingUpdate;
    this.onEngineUpdate = onEngineUpdate;

    this.stream = null;
    this.running = false;
    this.animationFrame = 0;
    this.handLandmarker = null;
    this.mediaPipeLoading = false;
    this.mediaPipeAttempt = 0;
    this.engine = "none";
    this.lastVideoTime = -1;
    this.lastInferenceTime = 0;
    this.lastMotionTime = 0;
    this.previousPalmX = null;
    this.previousPalmTime = null;
    this.smoothedPalmVelocity = 0;
    this.lastHandSeenTime = 0;
    this.lastStrokeTime = 0;
    this.strokeLockedUntil = 0;

    this.analysisCanvas = document.createElement("canvas");
    this.analysisCanvas.width = 96;
    this.analysisCanvas.height = 72;
    this.analysisContext = this.analysisCanvas.getContext("2d", { willReadFrequently: true });
    this.motionAnalyzer = new MotionAnalyzer({
      sampleStep: 2,
      differenceThreshold: 24,
      minimumMotionRatio: 0.012,
    });

    const query = new URLSearchParams(location.search);
    this.skipMediaPipe = query.has("offline") || query.get("engine") === "motion";
    this.loadTimeoutMs = query.has("test") ? 900 : 6500;
  }

  setCameraStatus(message, state = "neutral") {
    if (!this.cameraStatusElement) return;
    this.cameraStatusElement.textContent = message;
    this.cameraStatusElement.dataset.state = state;
  }

  updateEngine(engine, state, message, extra = {}) {
    this.engine = engine;
    this.onEngineUpdate?.({ engine, state, message, ...extra });
  }

  async start() {
    if (this.running) return;

    if (!window.isSecureContext) {
      throw new Error("카메라는 HTTPS 주소 또는 localhost에서만 사용할 수 있습니다.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("이 브라우저는 카메라 입력을 지원하지 않습니다.");
    }

    this.setCameraStatus("카메라 연결을 요청하는 중…", "loading");
    this.updateEngine("motion", "loading", "카메라가 연결되면 움직임 감지를 먼저 시작합니다.");

    try {
      this.stream = await this.requestCameraStream();
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.setAttribute("playsinline", "");

      // Safari를 포함한 브라우저별 차이를 줄이기 위해 재생 요청과 메타데이터 대기를 함께 시작한다.
      const playPromise = this.video.play();
      await withTimeout(
        Promise.all([this.waitForVideoReady(), playPromise]),
        9000,
        "카메라 영상 준비 시간이 너무 길어졌습니다.",
      );

      this.running = true;
      this.lastVideoTime = -1;
      this.previousPalmX = null;
      this.previousPalmTime = null;
      this.smoothedPalmVelocity = 0;
      this.motionAnalyzer.reset();
      this.resizeOverlay();
      this.setCameraStatus("카메라 연결 완료 · 손을 좌우로 빠르게 움직이세요.", "ready");
      this.updateEngine(
        "motion",
        "ready",
        "카메라 움직임 감지로 즉시 작동 중 · MediaPipe 손 인식을 준비합니다.",
      );
      this.loop();

      // 카메라는 이미 작동한다. MediaPipe 로딩은 별도로 진행하여 CDN 문제로 카메라까지 멈추지 않게 한다.
      if (!this.skipMediaPipe) {
        void this.initializeMediaPipeInBackground();
      } else {
        this.updateEngine("motion", "fallback", "오프라인 설정: 카메라 움직임 감지 모드로 작동합니다.");
      }
    } catch (error) {
      this.stopStreamOnly();
      this.setCameraStatus(this.friendlyError(error), "error");
      this.updateEngine("none", "error", "카메라를 시작하지 못했습니다. 수동 조작을 이용하세요.");
      throw error;
    }
  }

  async requestCameraStream() {
    const attempts = [
      {
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        },
        audio: false,
      },
      { video: true, audio: false },
    ];

    let lastError;
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        lastError = error;
        const retryable = ["OverconstrainedError", "ConstraintNotSatisfiedError", "TypeError"].includes(
          error?.name,
        );
        if (!retryable) break;
      }
    }
    throw lastError ?? new Error("카메라 스트림을 열 수 없습니다.");
  }

  waitForVideoReady() {
    if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA && this.video.videoWidth > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.video.removeEventListener("loadedmetadata", onReady);
        this.video.removeEventListener("loadeddata", onReady);
        this.video.removeEventListener("error", onError);
      };
      const onReady = () => {
        if (this.video.videoWidth > 0) {
          cleanup();
          resolve();
        }
      };
      const onError = () => {
        cleanup();
        reject(this.video.error ?? new Error("카메라 영상을 읽지 못했습니다."));
      };

      this.video.addEventListener("loadedmetadata", onReady);
      this.video.addEventListener("loadeddata", onReady);
      this.video.addEventListener("error", onError);
    });
  }

  async initializeMediaPipeInBackground({ force = false } = {}) {
    if (!this.running || this.mediaPipeLoading) return;
    if (this.handLandmarker && !force) return;

    if (force && this.handLandmarker) {
      try {
        this.handLandmarker.close?.();
      } catch {
        // 종료 오류는 재시도를 막지 않는다.
      }
      this.handLandmarker = null;
    }

    this.mediaPipeLoading = true;
    this.mediaPipeAttempt += 1;
    const attemptId = this.mediaPipeAttempt;
    this.updateEngine("motion", "loading", "MediaPipe 손 인식 파일을 불러오는 중…");

    let lastError = null;
    for (const source of MEDIAPIPE_SOURCES) {
      if (!this.running || attemptId !== this.mediaPipeAttempt) break;
      try {
        const moduleNamespace = await withTimeout(
          import(/* @vite-ignore */ source.moduleUrl),
          this.loadTimeoutMs,
          `${source.label} 연결 시간이 초과되었습니다.`,
        );
        const { FilesetResolver, HandLandmarker } = resolveMediaPipeApi(moduleNamespace);
        const fileset = await withTimeout(
          FilesetResolver.forVisionTasks(source.wasmUrl),
          this.loadTimeoutMs,
          "MediaPipe 실행 파일 준비 시간이 초과되었습니다.",
        );

        let landmarker;
        try {
          landmarker = await withTimeout(
            HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
              runningMode: "VIDEO",
              numHands: 1,
              minHandDetectionConfidence: 0.5,
              minHandPresenceConfidence: 0.45,
              minTrackingConfidence: 0.45,
            }),
            this.loadTimeoutMs * 1.8,
            "손 인식 모델 준비 시간이 초과되었습니다.",
          );
        } catch (gpuError) {
          landmarker = await withTimeout(
            HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
              runningMode: "VIDEO",
              numHands: 1,
              minHandDetectionConfidence: 0.5,
              minHandPresenceConfidence: 0.45,
              minTrackingConfidence: 0.45,
            }),
            this.loadTimeoutMs * 1.8,
            "CPU 손 인식 모델 준비 시간이 초과되었습니다.",
          );
        }

        if (!this.running || attemptId !== this.mediaPipeAttempt) {
          landmarker.close?.();
          break;
        }

        this.handLandmarker = landmarker;
        this.engine = "mediapipe";
        this.previousPalmX = null;
        this.previousPalmTime = null;
        this.smoothedPalmVelocity = 0;
        this.updateEngine(
          "mediapipe",
          "ready",
          `MediaPipe 손 관절 인식 작동 중 · ${source.label}`,
          { source: source.label },
        );
        this.mediaPipeLoading = false;
        return;
      } catch (error) {
        lastError = error;
        // 즉시 발생한 오류(404 등)는 다음 소스를 시도한다. 시간 초과는 네트워크 차단 가능성이 커서 중단한다.
        if (/시간이 초과/.test(error?.message ?? "")) break;
      }
    }

    this.mediaPipeLoading = false;
    if (!this.running || attemptId !== this.mediaPipeAttempt) return;
    this.engine = "motion";
    this.updateEngine(
      "motion",
      "fallback",
      "MediaPipe 연결이 되지 않아 카메라 움직임 감지로 계속 작동합니다.",
      { error: lastError },
    );
  }

  retryMediaPipe() {
    if (!this.running) return Promise.resolve(false);
    return this.initializeMediaPipeInBackground({ force: true }).then(() => this.engine === "mediapipe");
  }

  loop = (timestamp = performance.now()) => {
    if (!this.running) return;

    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.resizeOverlay();
      const currentTime = this.video.currentTime;

      if (
        this.engine === "mediapipe" &&
        this.handLandmarker &&
        currentTime !== this.lastVideoTime &&
        timestamp - this.lastInferenceTime >= 42
      ) {
        this.lastVideoTime = currentTime;
        this.lastInferenceTime = timestamp;
        this.processMediaPipeFrame(timestamp);
      } else if (
        this.engine !== "mediapipe" &&
        currentTime !== this.lastVideoTime &&
        timestamp - this.lastMotionTime >= 70
      ) {
        this.lastVideoTime = currentTime;
        this.lastMotionTime = timestamp;
        this.processMotionFrame(timestamp);
      }
    }

    this.animationFrame = requestAnimationFrame(this.loop);
  };

  processMediaPipeFrame(timestamp) {
    try {
      const result = this.handLandmarker.detectForVideo(this.video, timestamp);
      this.processLandmarks(result?.landmarks?.[0], timestamp);
    } catch (error) {
      this.handLandmarker = null;
      this.engine = "motion";
      this.motionAnalyzer.reset();
      this.updateEngine(
        "motion",
        "fallback",
        "MediaPipe 처리 오류로 카메라 움직임 감지로 전환했습니다.",
        { error },
      );
    }
  }

  processLandmarks(landmarks, timestamp) {
    this.clearOverlay();
    if (!landmarks) {
      this.previousPalmX = null;
      this.previousPalmTime = null;
      this.smoothedPalmVelocity *= 0.72;
      this.onTrackingUpdate?.({
        detected: false,
        open: false,
        velocity: 0,
        engine: "mediapipe",
      });
      if (timestamp - this.lastHandSeenTime > 900) {
        this.setCameraStatus("손바닥 전체가 화면 안에 보이도록 해 주세요.", "waiting");
      }
      return;
    }

    this.lastHandSeenTime = timestamp;
    this.drawLandmarks(landmarks);

    const palm = averageLandmarks(landmarks, [0, 5, 9, 13, 17]);
    const displayPalmX = 1 - palm.x;
    const displayPalmY = palm.y;
    const openInfo = this.isOpenHand(landmarks, palm);

    let rawVelocity = 0;
    if (this.previousPalmX !== null && this.previousPalmTime !== null) {
      const deltaSeconds = clamp((timestamp - this.previousPalmTime) / 1000, 0.015, 0.16);
      rawVelocity = (displayPalmX - this.previousPalmX) / deltaSeconds;
    }
    this.previousPalmX = displayPalmX;
    this.previousPalmTime = timestamp;
    this.smoothedPalmVelocity = this.smoothedPalmVelocity * 0.58 + rawVelocity * 0.42;

    const emitted = this.maybeEmitWind({
      velocityX: this.smoothedPalmVelocity,
      confidence: openInfo.open ? 1 : 0.35,
      timestamp,
      centerX: displayPalmX,
      centerY: displayPalmY,
      requireOpen: true,
      open: openInfo.open,
      engine: "mediapipe",
    });

    if (emitted) {
      this.setCameraStatus("바람을 만들었습니다. 손을 천천히 되돌리세요.", "active");
    } else if (!openInfo.open) {
      this.setCameraStatus("손가락을 펴고 손바닥을 카메라에 보여 주세요.", "waiting");
    } else {
      this.setCameraStatus("손바닥을 한쪽으로 빠르게 밀어 보세요.", "ready");
    }

    this.onTrackingUpdate?.({
      detected: true,
      open: openInfo.open,
      extendedFingers: openInfo.extendedFingers,
      velocity: this.smoothedPalmVelocity,
      centerX: displayPalmX,
      centerY: displayPalmY,
      engine: "mediapipe",
    });
  }

  processMotionFrame(timestamp) {
    const width = this.analysisCanvas.width;
    const height = this.analysisCanvas.height;
    const context = this.analysisContext;

    try {
      context.save();
      context.clearRect(0, 0, width, height);
      context.translate(width, 0);
      context.scale(-1, 1);
      context.drawImage(this.video, 0, 0, width, height);
      context.restore();
      const frame = context.getImageData(0, 0, width, height);
      const result = this.motionAnalyzer.analyze(frame.data, width, height, timestamp);

      this.clearOverlay();
      if (result.detected && result.centerX !== null && result.centerY !== null) {
        this.drawMotionMarker(result.centerX, result.centerY, result.velocityX, result.strength);
      }

      const emitted = this.maybeEmitWind({
        velocityX: result.velocityX,
        confidence: result.strength,
        timestamp,
        centerX: result.centerX ?? 0.5,
        centerY: result.centerY ?? 0.5,
        requireOpen: false,
        open: true,
        engine: "motion",
      });

      if (emitted) {
        this.setCameraStatus("움직임 방향으로 바람을 만들었습니다.", "active");
      } else if (result.detected) {
        this.setCameraStatus("손을 조금 더 빠르게 한쪽으로 움직여 보세요.", "ready");
      } else {
        this.setCameraStatus("손을 화면 안에서 좌우로 움직여 보세요.", "ready");
      }

      this.onTrackingUpdate?.({
        detected: result.detected,
        open: true,
        velocity: result.velocityX,
        motionRatio: result.motionRatio,
        centerX: result.centerX,
        centerY: result.centerY,
        engine: "motion",
      });
    } catch (error) {
      this.onTrackingUpdate?.({ detected: false, engine: "motion", error });
    }
  }

  maybeEmitWind({
    velocityX,
    confidence,
    timestamp,
    centerX,
    centerY,
    requireOpen,
    open,
    engine,
  }) {
    const speed = Math.abs(velocityX);
    const minimumSpeed = engine === "mediapipe" ? 0.48 : 0.38;
    const ready =
      speed >= minimumSpeed &&
      confidence >= (engine === "mediapipe" ? 0.5 : 0.12) &&
      (!requireOpen || open) &&
      timestamp >= this.strokeLockedUntil &&
      timestamp - this.lastStrokeTime >= 160;

    if (!ready) return false;

    const direction = Math.sign(velocityX) || 1;
    const normalized = clamp((speed - minimumSpeed) / (engine === "mediapipe" ? 1.45 : 1.15), 0, 1);
    const confidenceBoost = clamp(confidence, 0, 1) * 0.18;
    const windStrength = clamp(3.1 + (normalized * 0.82 + confidenceBoost) * 6.9, 3.1, 10);

    this.lastStrokeTime = timestamp;
    this.strokeLockedUntil = timestamp + 220;
    this.onWindImpulse?.(direction * windStrength, {
      speed,
      strength: windStrength,
      direction,
      centerX,
      centerY,
      engine,
    });
    this.drawStrokeArrow(centerX, centerY, direction, normalized);
    return true;
  }

  isOpenHand(landmarks, palm) {
    const pairs = [
      [8, 6],
      [12, 10],
      [16, 14],
      [20, 18],
    ];
    let extendedFingers = 0;
    for (const [tipIndex, jointIndex] of pairs) {
      const tipDistance = distance(landmarks[tipIndex], palm);
      const jointDistance = distance(landmarks[jointIndex], palm);
      if (tipDistance > jointDistance * 1.1) extendedFingers += 1;
    }

    const palmScale = Math.max(0.02, distance(landmarks[0], landmarks[9]));
    const spread =
      [8, 12, 16, 20].reduce((sum, index) => sum + distance(landmarks[index], palm), 0) /
      4 /
      palmScale;

    return {
      open: extendedFingers >= 3 && spread > 1.0,
      extendedFingers,
      spread,
    };
  }

  resizeOverlay() {
    const width = this.video.videoWidth || 640;
    const height = this.video.videoHeight || 480;
    const maxDimension = 960;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    if (this.overlay.width !== targetWidth || this.overlay.height !== targetHeight) {
      this.overlay.width = targetWidth;
      this.overlay.height = targetHeight;
    }
  }

  clearOverlay() {
    this.overlayContext.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  drawLandmarks(landmarks) {
    const context = this.overlayContext;
    const width = this.overlay.width;
    const height = this.overlay.height;

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "rgba(50, 235, 187, 0.95)";
    context.lineWidth = Math.max(2, width / 260);

    for (const [start, end] of HAND_CONNECTIONS) {
      const a = landmarks[start];
      const b = landmarks[end];
      if (!a || !b) continue;
      context.beginPath();
      context.moveTo((1 - a.x) * width, a.y * height);
      context.lineTo((1 - b.x) * width, b.y * height);
      context.stroke();
    }

    landmarks.forEach((point, index) => {
      context.beginPath();
      context.arc(
        (1 - point.x) * width,
        point.y * height,
        index % 4 === 0 ? 4.2 : 3,
        0,
        Math.PI * 2,
      );
      context.fillStyle = index % 4 === 0 ? "#ffe79b" : "#ffffff";
      context.fill();
      context.strokeStyle = "rgba(18, 62, 78, 0.85)";
      context.lineWidth = 1.1;
      context.stroke();
    });
    context.restore();
  }

  drawMotionMarker(xNormalized, yNormalized, velocityX, strength) {
    const context = this.overlayContext;
    const width = this.overlay.width;
    const height = this.overlay.height;
    const x = clamp(xNormalized, 0, 1) * width;
    const y = clamp(yNormalized, 0, 1) * height;
    const radius = 18 + clamp(strength, 0, 1) * 24;

    context.save();
    context.strokeStyle = "rgba(108, 225, 255, 0.9)";
    context.fillStyle = "rgba(108, 225, 255, 0.16)";
    context.lineWidth = Math.max(2, width / 300);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    if (Math.abs(velocityX) > 0.12) {
      this.drawStrokeArrow(xNormalized, yNormalized, Math.sign(velocityX), clamp(strength, 0, 1));
    }
    context.restore();
  }

  drawStrokeArrow(xNormalized, yNormalized, direction, strength) {
    const context = this.overlayContext;
    const width = this.overlay.width;
    const height = this.overlay.height;
    const x = clamp(xNormalized, 0, 1) * width;
    const y = clamp(yNormalized, 0, 1) * height;
    const length = direction * (48 + clamp(strength, 0, 1) * 84);
    const endX = x + length;

    context.save();
    context.strokeStyle = "rgba(255, 216, 80, 0.98)";
    context.fillStyle = "rgba(255, 216, 80, 0.98)";
    context.lineWidth = Math.max(4, width / 180);
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(endX, y);
    context.stroke();
    context.beginPath();
    context.moveTo(endX, y);
    context.lineTo(endX - direction * 18, y - 10);
    context.lineTo(endX - direction * 18, y + 10);
    context.closePath();
    context.fill();
    context.restore();
  }

  stopStreamOnly() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.pause?.();
    this.video.srcObject = null;
  }

  stop({ disposeModel = false } = {}) {
    this.running = false;
    this.mediaPipeAttempt += 1;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.stopStreamOnly();
    this.clearOverlay();
    this.motionAnalyzer.reset();
    this.previousPalmX = null;
    this.previousPalmTime = null;
    this.smoothedPalmVelocity = 0;
    this.setCameraStatus("카메라가 꺼져 있습니다.", "neutral");
    this.updateEngine("none", "neutral", "카메라를 시작하면 인식 방식을 자동으로 선택합니다.");

    if (disposeModel && this.handLandmarker) {
      try {
        this.handLandmarker.close?.();
      } catch {
        // 브라우저 종료 중 오류는 무시한다.
      }
      this.handLandmarker = null;
    }
  }

  friendlyError(error) {
    const name = error?.name ?? "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "카메라 사용이 차단되었습니다. 주소창의 카메라 권한을 ‘허용’으로 바꿔 주세요.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "사용할 수 있는 카메라를 찾지 못했습니다.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "다른 앱이 카메라를 사용 중일 수 있습니다. 화상회의 앱을 닫고 다시 시도해 주세요.";
    }
    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
      return "요청한 카메라 설정을 사용할 수 없습니다. 브라우저를 새로고침해 다시 시도해 주세요.";
    }
    if (name === "SecurityError") {
      return "보안 설정 때문에 카메라를 사용할 수 없습니다. GitHub Pages의 HTTPS 주소에서 실행해 주세요.";
    }
    return error?.message || "카메라를 시작하지 못했습니다.";
  }
}
