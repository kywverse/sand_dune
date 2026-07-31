/**
 * MediaPipe를 불러오지 못했을 때 사용하는 가벼운 영상 움직임 분석기입니다.
 * 손의 관절을 찾는 기능은 아니며, 연속 프레임의 변화 중심이 좌우로 이동한 정도를 계산합니다.
 */

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function frameToLuma(rgba, width, height, sampleStep = 2) {
  const cols = Math.ceil(width / sampleStep);
  const rows = Math.ceil(height / sampleStep);
  const output = new Uint8Array(cols * rows);
  let target = 0;

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const source = (y * width + x) * 4;
      const red = rgba[source] ?? 0;
      const green = rgba[source + 1] ?? 0;
      const blue = rgba[source + 2] ?? 0;
      output[target] = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
      target += 1;
    }
  }

  return { luma: output, cols, rows };
}

export function compareLumaFrames(previous, current, cols, rows, options = {}) {
  const differenceThreshold = options.differenceThreshold ?? 24;
  const edgeMargin = options.edgeMargin ?? 0.04;
  const minX = cols * edgeMargin;
  const maxX = cols * (1 - edgeMargin);
  const minY = rows * edgeMargin;
  const maxY = rows * (1 - edgeMargin);

  let changed = 0;
  let weightedX = 0;
  let weightedY = 0;
  let totalEnergy = 0;
  let totalWeight = 0;
  let samples = 0;

  const length = Math.min(previous.length, current.length, cols * rows);
  for (let index = 0; index < length; index += 1) {
    const x = index % cols;
    const y = Math.floor(index / cols);
    if (x < minX || x > maxX || y < minY || y > maxY) continue;

    samples += 1;
    const difference = Math.abs(current[index] - previous[index]);
    if (difference < differenceThreshold) continue;

    // 큰 변화에 조금 더 큰 가중치를 주되, 노출 변화 한 번이 전체를 지배하지 않도록 제한합니다.
    const weight = Math.min(3, difference / differenceThreshold);
    changed += 1;
    totalEnergy += difference;
    totalWeight += weight;
    weightedX += x * weight;
    weightedY += y * weight;
  }

  const motionRatio = samples > 0 ? changed / samples : 0;
  return {
    changed,
    samples,
    motionRatio,
    centerX: totalWeight > 0 ? weightedX / totalWeight / Math.max(1, cols - 1) : null,
    centerY: totalWeight > 0 ? weightedY / totalWeight / Math.max(1, rows - 1) : null,
    energy: samples > 0 ? totalEnergy / samples / 255 : 0,
  };
}

export class MotionAnalyzer {
  constructor(options = {}) {
    this.sampleStep = options.sampleStep ?? 2;
    this.differenceThreshold = options.differenceThreshold ?? 24;
    this.minimumMotionRatio = options.minimumMotionRatio ?? 0.012;
    this.maximumGlobalMotionRatio = options.maximumGlobalMotionRatio ?? 0.62;
    this.previousLuma = null;
    this.previousCenterX = null;
    this.previousTimestamp = null;
    this.smoothedVelocityX = 0;
    this.smoothedMotionRatio = 0;
  }

  reset() {
    this.previousLuma = null;
    this.previousCenterX = null;
    this.previousTimestamp = null;
    this.smoothedVelocityX = 0;
    this.smoothedMotionRatio = 0;
  }

  analyze(rgba, width, height, timestampMs) {
    const { luma, cols, rows } = frameToLuma(rgba, width, height, this.sampleStep);
    const now = Number(timestampMs) || performance.now();

    if (!this.previousLuma || this.previousLuma.length !== luma.length) {
      this.previousLuma = luma;
      this.previousTimestamp = now;
      return {
        detected: false,
        centerX: null,
        centerY: null,
        velocityX: 0,
        motionRatio: 0,
        strength: 0,
      };
    }

    const comparison = compareLumaFrames(
      this.previousLuma,
      luma,
      cols,
      rows,
      { differenceThreshold: this.differenceThreshold },
    );

    this.previousLuma = luma;
    const deltaSeconds = clamp((now - (this.previousTimestamp ?? now)) / 1000, 0.03, 0.25);
    this.previousTimestamp = now;

    const globallyChanged = comparison.motionRatio > this.maximumGlobalMotionRatio;
    const detected =
      comparison.motionRatio >= this.minimumMotionRatio &&
      !globallyChanged &&
      comparison.centerX !== null;

    let rawVelocityX = 0;
    if (detected && this.previousCenterX !== null) {
      rawVelocityX = (comparison.centerX - this.previousCenterX) / deltaSeconds;
    }

    if (detected) {
      this.previousCenterX = comparison.centerX;
      this.smoothedVelocityX = this.smoothedVelocityX * 0.55 + rawVelocityX * 0.45;
      this.smoothedMotionRatio = this.smoothedMotionRatio * 0.55 + comparison.motionRatio * 0.45;
    } else {
      this.smoothedVelocityX *= 0.62;
      this.smoothedMotionRatio *= 0.65;
      if (this.smoothedMotionRatio < this.minimumMotionRatio * 0.35) {
        this.previousCenterX = null;
      }
    }

    const speedFactor = clamp((Math.abs(this.smoothedVelocityX) - 0.18) / 1.25, 0, 1);
    const areaFactor = clamp((this.smoothedMotionRatio - this.minimumMotionRatio) / 0.08, 0, 1);
    const strength = clamp(speedFactor * 0.78 + areaFactor * 0.22, 0, 1);

    return {
      detected,
      globallyChanged,
      centerX: comparison.centerX,
      centerY: comparison.centerY,
      velocityX: this.smoothedVelocityX,
      motionRatio: comparison.motionRatio,
      strength,
    };
  }
}
