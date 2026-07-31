import assert from "node:assert/strict";
import {
  classifyGrain,
  getFormationScore,
  getTransportState,
  logSliderToMillimeters,
  millimetersToLogSlider,
  thresholdWind,
} from "../js/science-model.js";
import { MotionAnalyzer, compareLumaFrames, frameToLuma } from "../js/motion-analyzer.js";

const sizes = [0.005, 0.02, 0.063, 0.25, 1, 2, 3, 5];
for (const size of sizes) {
  const threshold = thresholdWind(size);
  assert.ok(threshold >= 0 && threshold <= 10, `threshold range: ${size}`);
}

assert.equal(classifyGrain(0.02).id, "fine");
assert.equal(classifyGrain(0.25).id, "dune-sand");
assert.equal(classifyGrain(3).id, "gravel");
assert.ok(thresholdWind(0.02) > thresholdWind(0.25));
assert.ok(thresholdWind(3) > thresholdWind(0.25));
assert.equal(getTransportState(0.02, 2).id, "fine-held");
assert.equal(getTransportState(0.02, 8).id, "airborne");
assert.equal(getTransportState(0.25, 6).id, "hopping");
assert.equal(getTransportState(3, 6).id, "coarse-still");
assert.ok(getFormationScore(0.25, 6) > getFormationScore(0.02, 6));
assert.ok(getFormationScore(0.25, 6) > getFormationScore(3, 6));

for (const slider of [0, 25, 50, 75, 100]) {
  const size = logSliderToMillimeters(slider);
  const roundTrip = millimetersToLogSlider(size);
  assert.ok(Math.abs(slider - roundTrip) < 1e-8);
}

function makeFrame(width, height, rectangle = null, background = 0) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = rectangle &&
        x >= rectangle.x && x < rectangle.x + rectangle.width &&
        y >= rectangle.y && y < rectangle.y + rectangle.height;
      const value = inside ? 255 : background;
      const index = (y * width + x) * 4;
      rgba[index] = value;
      rgba[index + 1] = value;
      rgba[index + 2] = value;
      rgba[index + 3] = 255;
    }
  }
  return rgba;
}

const width = 48;
const height = 24;
const baseline = makeFrame(width, height);
const firstPosition = makeFrame(width, height, { x: 8, y: 6, width: 10, height: 12 });
const secondPosition = makeFrame(width, height, { x: 18, y: 6, width: 10, height: 12 });
const thirdPosition = makeFrame(width, height, { x: 28, y: 6, width: 10, height: 12 });

const lumaA = frameToLuma(baseline, width, height, 2);
const lumaB = frameToLuma(firstPosition, width, height, 2);
const comparison = compareLumaFrames(lumaA.luma, lumaB.luma, lumaA.cols, lumaA.rows);
assert.ok(comparison.motionRatio > 0);
assert.ok(comparison.centerX !== null);

const analyzer = new MotionAnalyzer({
  sampleStep: 2,
  differenceThreshold: 20,
  minimumMotionRatio: 0.005,
});
analyzer.analyze(baseline, width, height, 0);
analyzer.analyze(firstPosition, width, height, 100);
const movingRight1 = analyzer.analyze(secondPosition, width, height, 200);
const movingRight2 = analyzer.analyze(thirdPosition, width, height, 300);
assert.ok(movingRight1.detected || movingRight2.detected);
assert.ok(movingRight2.velocityX > 0, `expected positive velocity, received ${movingRight2.velocityX}`);

const unchanged = new MotionAnalyzer({ minimumMotionRatio: 0.005 });
unchanged.analyze(baseline, width, height, 0);
const unchangedResult = unchanged.analyze(baseline, width, height, 100);
assert.equal(unchangedResult.detected, false);

const globalChange = new MotionAnalyzer({ minimumMotionRatio: 0.005 });
globalChange.analyze(makeFrame(width, height, null, 0), width, height, 0);
const globalResult = globalChange.analyze(makeFrame(width, height, null, 255), width, height, 100);
assert.equal(globalResult.detected, false, "global exposure change should be ignored");

console.log("과학 모형·영상 움직임 분석 테스트 통과");
