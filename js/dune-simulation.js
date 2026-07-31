import {
  clamp,
  formatGrainSize,
  getScienceSummary,
  retentionRatio,
} from "./science-model.js";

const TAU = Math.PI * 2;

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DuneSimulation {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.label = options.label ?? "입자";
    this.grainSizeMm = options.grainSizeMm ?? 0.25;
    this.compact = Boolean(options.compact);
    this.seed = options.seed ?? 11;
    this.random = mulberry32(this.seed);
    this.paused = false;
    this.wind = 0;
    this.cssWidth = 640;
    this.cssHeight = this.compact ? 250 : 430;
    this.dpr = 1;
    this.reset();
  }

  reset() {
    this.elapsed = 0;
    this.initialCenter = 0.43;
    this.duneCenter = this.initialCenter;
    this.duneAmplitude = 0.022;
    this.initialAmplitude = this.duneAmplitude;
    this.orientation = 1;
    this.fineSurfaceLoss = 0;
    this.movedIndex = 0;
    this.lostIndex = 0;
    this.depositedIndex = 0;
    this.particles = [];
    this.spawnCarry = 0;
    this.noisePhase = this.random() * TAU;
    this.lastSummary = getScienceSummary(this.grainSizeMm, 0);
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
  }

  setGrainSize(sizeMm, { reset = false } = {}) {
    this.grainSizeMm = clamp(Number(sizeMm), 0.005, 5);
    if (reset) this.reset();
  }

  resize(width, height) {
    // hidden 요소의 getBoundingClientRect()는 0×0을 반환한다. 그 상태에서 임의의 최소 크기로
    // 캔버스를 만들면 모드 전환 직후 화면이 늘어나거나 흐려질 수 있으므로, 보이는 크기만 적용한다.
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 40 || height < 40) {
      return false;
    }

    const safeWidth = Math.round(width);
    const safeHeight = Math.round(height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (
      safeWidth === this.cssWidth &&
      safeHeight === this.cssHeight &&
      dpr === this.dpr
    ) {
      return false;
    }

    this.cssWidth = safeWidth;
    this.cssHeight = safeHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(safeWidth * dpr);
    this.canvas.height = Math.round(safeHeight * dpr);
    this.canvas.style.width = `${safeWidth}px`;
    this.canvas.style.height = `${safeHeight}px`;
    return true;
  }

  update(dtSeconds, signedWind) {
    this.wind = clamp(Number(signedWind) || 0, -10, 10);
    this.lastSummary = getScienceSummary(this.grainSizeMm, this.wind);

    if (this.paused) return;

    const dt = clamp(dtSeconds, 0, 0.05);
    this.elapsed += dt;

    const windStrength = Math.abs(this.wind);
    const direction = Math.sign(this.wind) || Math.sign(this.orientation) || 1;
    this.orientation += (direction - this.orientation) * Math.min(1, dt * 4.2);

    const { state, threshold, score } = this.lastSummary;
    const excess = Math.max(0, windStrength - threshold);
    const intensity = clamp(excess / 3.2, 0, 1);
    const retention = retentionRatio(this.grainSizeMm, windStrength);

    if (state.moving) {
      if (state.id === "airborne") {
        const lossRate = (0.014 + intensity * 0.034) * dt;
        this.fineSurfaceLoss = clamp(this.fineSurfaceLoss + lossRate, 0, 0.13);
        this.duneAmplitude += (0.009 - this.duneAmplitude) * Math.min(1, dt * 0.45);
        this.movedIndex += lossRate * 740;
        this.lostIndex += lossRate * 690;
        this.spawnParticles("airborne", dt, 17 + windStrength * 5.5, direction, intensity);
      } else if (state.id === "hopping") {
        const growthRate = (0.004 + 0.032 * score * (0.35 + intensity * 0.65)) * dt;
        const saturation = 1 - clamp(this.duneAmplitude / 0.235, 0, 0.96);
        const growth = growthRate * (0.35 + saturation * 0.65);
        this.duneAmplitude = clamp(this.duneAmplitude + growth, 0.012, 0.235);

        const migrationRate =
          direction * (0.0022 + intensity * 0.0105) * (0.72 + (1 - score) * 0.28) * dt;
        this.duneCenter += migrationRate;
        this.handleBoundary(direction, dt, intensity);

        this.movedIndex += dt * (2.2 + windStrength * 1.6) * (0.45 + intensity);
        this.depositedIndex += growth * 580 * retention;
        this.lostIndex += dt * intensity * (1 - retention) * 1.8;
        this.spawnParticles("hopping", dt, 8 + windStrength * 3.3, direction, intensity);
      } else if (state.id === "rolling") {
        const growth = dt * score * (0.003 + intensity * 0.008);
        this.duneAmplitude = clamp(this.duneAmplitude + growth, 0.015, 0.16);
        this.duneCenter += direction * dt * (0.001 + intensity * 0.0035);
        this.handleBoundary(direction, dt, intensity);
        this.movedIndex += dt * (0.8 + windStrength * 0.65) * (0.3 + intensity);
        this.depositedIndex += growth * 430 * retention;
        this.spawnParticles("rolling", dt, 4 + windStrength * 1.5, direction, intensity);
      } else if (state.id === "coarse-rolling") {
        const growth = dt * score * intensity * 0.0015;
        this.duneAmplitude = clamp(this.duneAmplitude + growth, 0.02, 0.075);
        this.duneCenter += direction * dt * intensity * 0.0008;
        this.movedIndex += dt * intensity * 0.55;
        this.spawnParticles("coarse", dt, 1.5 + windStrength * 0.4, direction, intensity);
      }
    } else {
      this.spawnCarry = 0;
    }

    this.updateParticles(dt);
  }

  handleBoundary(direction, dt, intensity) {
    const minCenter = 0.15;
    const maxCenter = 0.86;
    if (this.duneCenter > maxCenter) {
      this.duneCenter = maxCenter;
      const leakage = dt * intensity * 0.011;
      this.duneAmplitude = Math.max(0.018, this.duneAmplitude - leakage);
      this.lostIndex += leakage * 180;
    } else if (this.duneCenter < minCenter) {
      this.duneCenter = minCenter;
      const leakage = dt * intensity * 0.011;
      this.duneAmplitude = Math.max(0.018, this.duneAmplitude - leakage);
      this.lostIndex += leakage * 180;
    }

    if (direction > 0 && this.duneCenter < this.initialCenter - 0.12) {
      this.duneCenter += dt * 0.004;
    }
    if (direction < 0 && this.duneCenter > this.initialCenter + 0.12) {
      this.duneCenter -= dt * 0.004;
    }
  }

  spawnParticles(type, dt, ratePerSecond, direction, intensity) {
    this.spawnCarry += dt * ratePerSecond;
    const count = Math.floor(this.spawnCarry);
    this.spawnCarry -= count;

    for (let i = 0; i < count; i += 1) {
      if (this.particles.length > (this.compact ? 95 : 170)) break;
      const fromDune = type !== "airborne" && this.random() > 0.18;
      let x = fromDune
        ? this.duneCenter - direction * (0.05 + this.random() * 0.13)
        : direction > 0
          ? 0.02 + this.random() * 0.25
          : 0.73 + this.random() * 0.25;
      x = clamp(x, 0.01, 0.99);
      const groundY = this.getGroundY(x);

      if (type === "airborne") {
        this.particles.push({
          type,
          x,
          y: groundY - this.random() * 0.012,
          vx: direction * (0.14 + intensity * 0.27 + this.random() * 0.08),
          vy: -(0.05 + this.random() * 0.14),
          age: 0,
          life: 1.1 + this.random() * 1.5,
          size: 0.7 + this.random() * 1.4,
          phase: this.random() * TAU,
        });
      } else if (type === "hopping") {
        this.particles.push({
          type,
          x,
          y: groundY - 0.006,
          startX: x,
          direction,
          distance: 0.035 + intensity * 0.08 + this.random() * 0.055,
          height: 0.018 + intensity * 0.055 + this.random() * 0.025,
          age: 0,
          life: 0.34 + this.random() * 0.28,
          size: 1.2 + this.random() * 1.7,
        });
      } else {
        this.particles.push({
          type,
          x,
          y: groundY - 0.003,
          vx: direction * (0.025 + intensity * 0.055 + this.random() * 0.015),
          age: 0,
          life: 0.55 + this.random() * 0.55,
          size: type === "coarse" ? 2.7 + this.random() * 2 : 1.8 + this.random() * 2,
          rotation: this.random() * TAU,
        });
      }
    }
  }

  updateParticles(dt) {
    const next = [];
    for (const particle of this.particles) {
      particle.age += dt;
      if (particle.age >= particle.life) continue;

      if (particle.type === "airborne") {
        particle.x += particle.vx * dt;
        particle.vy += 0.015 * dt;
        particle.y += particle.vy * dt;
        particle.y += Math.sin(particle.phase + particle.age * 9) * 0.0007;
      } else if (particle.type === "hopping") {
        const t = clamp(particle.age / particle.life, 0, 1);
        particle.x = particle.startX + particle.direction * particle.distance * t;
        const ground = this.getGroundY(clamp(particle.x, 0, 1));
        particle.y = ground - Math.sin(Math.PI * t) * particle.height;
      } else {
        particle.x += particle.vx * dt;
        particle.y = this.getGroundY(clamp(particle.x, 0, 1)) - 0.004;
        particle.rotation += particle.vx * dt * 38;
      }

      if (particle.x > -0.05 && particle.x < 1.05 && particle.y > -0.15 && particle.y < 1.08) {
        next.push(particle);
      }
    }
    this.particles = next;
  }

  getGroundY(xNormalized) {
    const x = clamp(xNormalized, 0, 1);
    const orientation = Math.abs(this.orientation) < 0.2 ? 1 : this.orientation;
    const signedDistance = (x - this.duneCenter) * orientation;
    const windwardWidth = 0.19;
    const leeWidth = 0.07;
    const width = signedDistance < 0 ? windwardWidth : leeWidth;
    const mainDune = this.duneAmplitude * Math.exp(-0.5 * (signedDistance / width) ** 2);

    const shoulder =
      this.duneAmplitude *
      0.16 *
      Math.exp(-0.5 * ((signedDistance + 0.18) / 0.12) ** 2);

    const microRelief =
      0.0032 * Math.sin(x * TAU * 2.2 + this.noisePhase) +
      0.0018 * Math.sin(x * TAU * 5.1 + this.noisePhase * 0.7);

    const base = 0.79 + this.fineSurfaceLoss;
    return clamp(base - mainDune - shoulder - microRelief, 0.42, 0.91);
  }

  getStats() {
    const summary = this.lastSummary ?? getScienceSummary(this.grainSizeMm, this.wind);
    const heightIndex = clamp(
      ((this.duneAmplitude - this.initialAmplitude) / (0.235 - this.initialAmplitude)) * 100,
      0,
      100,
    );
    const migrationIndex = Math.abs(this.duneCenter - this.initialCenter) * 100;

    return {
      label: this.label,
      grainSizeMm: this.grainSizeMm,
      stateTitle: summary.state.title,
      stateId: summary.state.id,
      formation: summary.state.formation,
      score: summary.score,
      threshold: summary.threshold,
      heightIndex,
      migrationIndex,
      movedIndex: this.movedIndex,
      lostIndex: this.lostIndex,
      depositedIndex: this.depositedIndex,
      elapsed: this.elapsed,
    };
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    const dpr = this.dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#dff3ff");
    sky.addColorStop(0.58, "#f5fbff");
    sky.addColorStop(1, "#fff4d6");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    this.drawHorizon(ctx, w, h);
    this.drawWind(ctx, w, h);
    this.drawTerrain(ctx, w, h);
    this.drawParticles(ctx, w, h);
    this.drawCanvasLabels(ctx, w, h);
  }

  drawHorizon(ctx, w, h) {
    const horizonY = h * 0.58;
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = "#d7b278";
    ctx.beginPath();
    ctx.moveTo(0, horizonY + 12);
    for (let x = 0; x <= w; x += Math.max(12, w / 35)) {
      const y = horizonY + Math.sin(x * 0.014 + 0.7) * 7 + Math.sin(x * 0.006) * 5;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawWind(ctx, w, h) {
    const strength = Math.abs(this.wind);
    if (strength < 0.25) return;

    const direction = Math.sign(this.wind) || 1;
    const arrowCount = this.compact ? 3 : 5;
    const speedOffset = (this.elapsed * (22 + strength * 9)) % (w / arrowCount);

    ctx.save();
    ctx.lineWidth = this.compact ? 1.5 : 2;
    ctx.strokeStyle = `rgba(26, 113, 173, ${0.34 + strength * 0.045})`;
    ctx.fillStyle = ctx.strokeStyle;

    for (let i = 0; i < arrowCount; i += 1) {
      const laneY = h * (0.18 + (i % 2) * 0.11);
      let x = (i + 0.25) * (w / arrowCount);
      x += direction * speedOffset;
      while (x < -70) x += w + 80;
      while (x > w + 70) x -= w + 80;
      this.drawArrow(ctx, x, laneY, direction * (35 + strength * 3.5));
    }
    ctx.restore();
  }

  drawArrow(ctx, x, y, length) {
    const direction = Math.sign(length) || 1;
    const x2 = x + length;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y);
    ctx.lineTo(x2 - direction * 9, y - 5);
    ctx.lineTo(x2 - direction * 9, y + 5);
    ctx.closePath();
    ctx.fill();
  }

  drawTerrain(ctx, w, h) {
    const points = [];
    const samples = this.compact ? 100 : 160;
    for (let i = 0; i <= samples; i += 1) {
      const xNorm = i / samples;
      points.push([xNorm * w, this.getGroundY(xNorm) * h]);
    }

    const sandGradient = ctx.createLinearGradient(0, h * 0.55, 0, h);
    sandGradient.addColorStop(0, "#e6bb6c");
    sandGradient.addColorStop(0.55, "#d99b49");
    sandGradient.addColorStop(1, "#a9682e");

    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points) ctx.lineTo(x, y);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = sandGradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points) ctx.lineTo(x, y);
    ctx.strokeStyle = "rgba(119, 70, 27, 0.72)";
    ctx.lineWidth = this.compact ? 1.4 : 2;
    ctx.stroke();

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "#7a451f";
    ctx.lineWidth = 1;
    const stripeCount = this.compact ? 6 : 10;
    for (let i = 0; i < stripeCount; i += 1) {
      const y = h * (0.83 + i * 0.018);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(w * 0.28, y - 4, w * 0.7, y + 5, w, y - 1);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawParticles(ctx, w, h) {
    for (const particle of this.particles) {
      const x = particle.x * w;
      const y = particle.y * h;
      const lifeRatio = 1 - particle.age / particle.life;
      ctx.save();
      ctx.globalAlpha = clamp(lifeRatio * 1.3, 0, 1);

      if (particle.type === "airborne") {
        ctx.fillStyle = "rgba(141, 105, 62, 0.74)";
        ctx.beginPath();
        ctx.arc(x, y, particle.size, 0, TAU);
        ctx.fill();
      } else if (particle.type === "hopping") {
        ctx.fillStyle = "#9b5d24";
        ctx.beginPath();
        ctx.arc(x, y, particle.size, 0, TAU);
        ctx.fill();
      } else {
        ctx.translate(x, y);
        ctx.rotate(particle.rotation ?? 0);
        ctx.fillStyle = particle.type === "coarse" ? "#72543a" : "#8a552d";
        ctx.beginPath();
        ctx.ellipse(0, 0, particle.size, particle.size * 0.72, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawCanvasLabels(ctx, w, h) {
    const summary = this.lastSummary;
    const stats = this.getStats();
    const pad = this.compact ? 10 : 16;
    const titleSize = this.compact ? 13 : 16;
    const bodySize = this.compact ? 11 : 13;

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.84)";
    ctx.strokeStyle = "rgba(35, 60, 77, 0.12)";
    ctx.lineWidth = 1;
    const boxWidth = Math.min(w - pad * 2, this.compact ? 225 : 320);
    const boxHeight = this.compact ? 58 : 72;
    this.roundedRect(ctx, pad, pad, boxWidth, boxHeight, 11);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#17364a";
    ctx.font = `700 ${titleSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(this.label, pad + 12, pad + (this.compact ? 20 : 24));

    ctx.fillStyle = "#496474";
    ctx.font = `500 ${bodySize}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(
      `${formatGrainSize(this.grainSizeMm)} · ${summary.state.title}`,
      pad + 12,
      pad + (this.compact ? 40 : 48),
    );

    if (!this.compact) {
      ctx.fillStyle = "#59717f";
      ctx.font = `500 12px system-ui, -apple-system, sans-serif`;
      ctx.fillText(
        `사구 성장 지수 ${stats.heightIndex.toFixed(0)} · 관찰 구역 밖 이동 ${stats.lostIndex.toFixed(0)}`,
        pad + 12,
        pad + 65,
      );
    }

    if (!this.compact && this.duneAmplitude > 0.065 && summary.score > 0.34) {
      this.drawDuneAnnotations(ctx, w, h);
    }

    ctx.restore();
  }

  drawDuneAnnotations(ctx, w, h) {
    const direction = Math.sign(this.orientation) || 1;
    const crestX = this.duneCenter * w;
    const crestY = this.getGroundY(this.duneCenter) * h;
    const windwardX = (this.duneCenter - direction * 0.13) * w;
    const windwardY = this.getGroundY(this.duneCenter - direction * 0.13) * h;
    const leeX = (this.duneCenter + direction * 0.075) * w;
    const leeY = this.getGroundY(this.duneCenter + direction * 0.075) * h;

    ctx.font = "700 12px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = "rgba(68, 55, 36, 0.7)";
    ctx.fillStyle = "#51391f";

    this.annotatePoint(ctx, windwardX, windwardY, "바람받이 사면", -28);
    this.annotatePoint(ctx, crestX, crestY, "사구 마루", -35);
    this.annotatePoint(ctx, leeX, leeY, "바람그늘 사면", -27);
  }

  annotatePoint(ctx, x, y, label, offsetY) {
    ctx.beginPath();
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x, y + offsetY + 8);
    ctx.stroke();
    ctx.fillText(label, x, y + offsetY);
  }

  roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }
}
