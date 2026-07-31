/**
 * 사구 형성 교육용 개념 모형
 * 실제 풍동 실험의 절대 풍속을 계산하지 않고, 0~10의 상대 바람 세기를 사용한다.
 */

export const GRAIN_LIMITS = Object.freeze({
  SILT_SAND: 0.063,
  SAND_GRAVEL: 2.0,
});

export const PRESET_GRAINS = Object.freeze([
  {
    id: "fine",
    sizeMm: 0.02,
    shortLabel: "아주 작은 입자",
    label: "아주 작은 입자(실트 크기)",
  },
  {
    id: "sand",
    sizeMm: 0.25,
    shortLabel: "모래",
    label: "사구를 잘 이루는 모래",
  },
  {
    id: "coarse",
    sizeMm: 3.0,
    shortLabel: "큰 입자",
    label: "큰 입자(잔자갈 크기)",
  },
]);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function logSliderToMillimeters(value) {
  const minLog = Math.log10(0.005);
  const maxLog = Math.log10(5);
  const ratio = clamp(Number(value) / 100, 0, 1);
  return 10 ** (minLog + ratio * (maxLog - minLog));
}

export function millimetersToLogSlider(sizeMm) {
  const minLog = Math.log10(0.005);
  const maxLog = Math.log10(5);
  const ratio = (Math.log10(clamp(sizeMm, 0.005, 5)) - minLog) / (maxLog - minLog);
  return clamp(ratio * 100, 0, 100);
}

export function formatGrainSize(sizeMm) {
  if (sizeMm < 0.01) return `${sizeMm.toFixed(3)} mm`;
  if (sizeMm < 0.1) return `${sizeMm.toFixed(2)} mm`;
  if (sizeMm < 1) return `${sizeMm.toFixed(2)} mm`;
  return `${sizeMm.toFixed(1)} mm`;
}

export function classifyGrain(sizeMm) {
  const d = clamp(Number(sizeMm), 0.005, 5);

  if (d < GRAIN_LIMITS.SILT_SAND) {
    return {
      id: "fine",
      title: "실트·점토 크기의 아주 작은 입자",
      short: "아주 작은 입자",
      keyCause: "입자 사이의 응집력",
    };
  }
  if (d < 0.125) {
    return {
      id: "very-fine-sand",
      title: "매우 고운 모래",
      short: "매우 고운 모래",
      keyCause: "응집력과 바람의 힘이 함께 작용",
    };
  }
  if (d <= 0.5) {
    return {
      id: "dune-sand",
      title: "고운 모래~중간 크기 모래",
      short: "사구 형성에 유리한 모래",
      keyCause: "이동과 재퇴적의 균형",
    };
  }
  if (d < GRAIN_LIMITS.SAND_GRAVEL) {
    return {
      id: "coarse-sand",
      title: "굵은 모래",
      short: "굵은 모래",
      keyCause: "무게가 커져 이동이 감소",
    };
  }
  return {
    id: "gravel",
    title: "잔자갈 이상의 큰 입자",
    short: "큰 입자",
    keyCause: "큰 질량과 무게",
  };
}

/**
 * 상대 이동 시작 기준값(0~10).
 * 작은 입자 쪽에서는 응집력, 큰 입자 쪽에서는 무게 때문에 기준값이 커지는
 * U자형 경향을 교육용으로 단순화했다.
 */
export function thresholdWind(sizeMm) {
  const d = clamp(Number(sizeMm), 0.005, 5);
  const x = Math.log10(d / 0.2);
  let threshold = 2.55 + 1.15 * x * x;

  if (d < GRAIN_LIMITS.SILT_SAND) {
    const cohesion = Math.log10(GRAIN_LIMITS.SILT_SAND / d + 1);
    threshold += 1.75 * cohesion;
  }

  if (d > 0.5) {
    threshold += 2.15 * Math.sqrt(d - 0.5);
  }

  return clamp(threshold, 2.45, 9.6);
}

export function grainSuitability(sizeMm) {
  const d = clamp(Number(sizeMm), 0.005, 5);
  const distance = Math.log10(d / 0.25);
  const gaussian = Math.exp(-0.5 * (distance / 0.42) ** 2);

  if (d < 0.063 || d > 2) return gaussian * 0.12;
  return gaussian;
}

export function retentionRatio(sizeMm, windStrength) {
  const d = clamp(Number(sizeMm), 0.005, 5);
  const wind = clamp(Math.abs(Number(windStrength)), 0, 10);
  const threshold = thresholdWind(d);
  const excess = Math.max(0, wind - threshold);

  if (d < GRAIN_LIMITS.SILT_SAND) {
    return clamp(0.12 - excess * 0.012, 0.035, 0.12);
  }
  if (d <= 0.7) {
    return clamp(0.9 - excess * 0.025, 0.66, 0.9);
  }
  if (d < GRAIN_LIMITS.SAND_GRAVEL) {
    return clamp(0.76 - excess * 0.035, 0.48, 0.76);
  }
  return 0.94;
}

export function getTransportState(sizeMm, signedWind) {
  const d = clamp(Number(sizeMm), 0.005, 5);
  const wind = clamp(Math.abs(Number(signedWind)), 0, 10);
  const threshold = thresholdWind(d);
  const grain = classifyGrain(d);
  const moving = wind >= threshold && wind > 0.1;

  if (!moving) {
    if (grain.id === "fine") {
      return {
        id: "fine-held",
        title: "입자끼리 달라붙어 표면에 남음",
        description:
          "입자가 매우 작으면 가볍지만, 입자 사이의 응집력이 커서 약한 바람에는 쉽게 떨어져 나오지 않습니다.",
        moving: false,
        formation: "낮음",
      };
    }
    if (grain.id === "gravel") {
      return {
        id: "coarse-still",
        title: "무거워서 거의 움직이지 않음",
        description:
          "입자의 질량이 커 현재 바람의 힘만으로는 굴리거나 들어 올리기 어렵습니다.",
        moving: false,
        formation: "낮음",
      };
    }
    return {
      id: "sand-still",
      title: "바람이 약해 거의 움직이지 않음",
      description:
        "이 크기의 입자를 움직이려면 현재보다 강한 바람이 필요합니다.",
      moving: false,
      formation: "낮음",
    };
  }

  if (d < GRAIN_LIMITS.SILT_SAND) {
    return {
      id: "airborne",
      title: "공중에 떠서 멀리 이동",
      description:
        "표면에서 떨어져 나온 아주 작은 입자는 공기 중에 오래 머물며 관찰 구역 밖으로 빠져나가기 쉽습니다.",
      moving: true,
      formation: "매우 낮음",
    };
  }

  if (d <= 0.7) {
    return {
      id: "hopping",
      title: "튀어 오르며 이동한 뒤 다시 쌓임",
      description:
        "모래가 지표 가까이에서 반복해서 튀어 오르고 떨어지면서 다른 모래를 움직이고 다시 퇴적됩니다.",
      moving: true,
      formation: grainSuitability(d) > 0.55 ? "높음" : "보통",
    };
  }

  if (d < GRAIN_LIMITS.SAND_GRAVEL) {
    return {
      id: "rolling",
      title: "지표면을 따라 구르거나 미끄러짐",
      description:
        "굵은 모래는 지표 가까이에서 짧게 움직이며, 고운 모래보다 이동량이 적습니다.",
      moving: true,
      formation: "보통 이하",
    };
  }

  return {
    id: "coarse-rolling",
    title: "아주 강한 바람에 조금씩 굴러감",
    description:
      "큰 입자도 매우 강한 바람에는 일부 움직일 수 있지만, 일반적인 조건에서 모래 사구처럼 쌓이기는 어렵습니다.",
    moving: true,
    formation: "매우 낮음",
  };
}

export function getFormationScore(sizeMm, signedWind) {
  const d = clamp(Number(sizeMm), 0.005, 5);
  const wind = clamp(Math.abs(Number(signedWind)), 0, 10);
  const threshold = thresholdWind(d);

  if (wind < threshold) return 0;

  const movementFactor = clamp((wind - threshold) / 2.2, 0, 1);
  const suitability = grainSuitability(d);
  const retention = retentionRatio(d, wind);
  return clamp(suitability * retention * (0.35 + movementFactor * 0.65), 0, 1);
}

export function getScienceSummary(sizeMm, signedWind) {
  const d = clamp(Number(sizeMm), 0.005, 5);
  const wind = clamp(Math.abs(Number(signedWind)), 0, 10);
  const grain = classifyGrain(d);
  const threshold = thresholdWind(d);
  const state = getTransportState(d, signedWind);
  const score = getFormationScore(d, signedWind);

  let conclusion;
  if (grain.id === "fine" && !state.moving) {
    conclusion = "작다고 해서 약한 바람에 곧바로 날리는 것은 아닙니다. 먼저 응집력을 이겨야 합니다.";
  } else if (grain.id === "fine") {
    conclusion = "한번 떨어져 나오면 멀리 날아가므로 이 자리에서 모래 사구로 쌓이기 어렵습니다.";
  } else if (score >= 0.55) {
    conclusion = "이동한 모래가 가까운 곳에 다시 쌓여 사구가 성장하기 좋은 조건입니다.";
  } else if (grain.id === "gravel") {
    conclusion = "입자가 커서 이동량이 매우 적으므로 사구가 성장하기 어렵습니다.";
  } else if (!state.moving) {
    conclusion = "바람이 이동 시작 기준보다 약해 사구가 거의 성장하지 않습니다.";
  } else {
    conclusion = "일부 이동과 퇴적은 가능하지만, 사구 형성 효율은 높지 않습니다.";
  }

  return {
    grain,
    state,
    threshold,
    score,
    conclusion,
    wind,
    sizeMm: d,
  };
}
