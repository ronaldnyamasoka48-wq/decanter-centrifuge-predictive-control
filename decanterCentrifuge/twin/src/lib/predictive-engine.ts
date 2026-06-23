// ============================================================
// Decanter Centrifuge Predictive Control Engine
// Simulates an ML-based adaptive control system
// ============================================================

export interface FeedProperties {
  density: number;        // g/cm³ (1.0 – 1.8)
  solidContent: number;   // % (0 – 60)
  viscosity: number;      // cP  (1 – 5000)
  particleSize: number;   // µm  (1 – 500)
  temperature: number;    // °C  (10 – 80)
  flowRate: number;       // L/min feed inlet (5 – 200)
}

export interface ControlOutputs {
  bowlSpeed: number;          // RPM  (800 – 4500)
  scrollSpeed: number;        // RPM  (differential, 1 – 35)
  differentialSpeed: number;  // RPM  (relative scroll – bowl)
  adjustedFlowRate: number;   // L/min optimised
  energyConsumption: number;  // kW
  bowlMotorTorque: number;    // N·m
  scrollMotorTorque: number;  // N·m
  separationEfficiency: number; // % predicted (proxy metric)
  gForce: number;             // G
  poolDepth: number;          // mm
  retentionTime: number;      // s
  solidsMoisture: number;     // % predicted
  confidence: number;         // % model confidence
  status: 'OPTIMAL' | 'WARNING' | 'CRITICAL' | 'STANDBY';
  alerts: string[];
}

export interface TrendPoint {
  time: number;
  bowlSpeed: number;
  scrollSpeed: number;
  energy: number;
  flowRate: number;
  gForce: number;
  efficiency: number;
}

// ─── Normalise helpers ────────────────────────────────────────
const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ─── Core prediction function ─────────────────────────────────
export function predict(feed: FeedProperties): ControlOutputs {
  const {
    density, solidContent, viscosity, particleSize, temperature, flowRate,
  } = feed;

  const alerts: string[] = [];

  // ── Bowl speed model ───────────────────────────────────────
  // Higher density + solids → need more G-force → higher bowl RPM
  // Higher viscosity → lower speed for stable operation
  // Larger particles → can use lower speed
  const densityFactor = (density - 1.0) / 0.8;            // 0–1
  const solidFactor   = solidContent / 60;                  // 0–1
  const viscNorm      = Math.log10(clamp(viscosity, 1, 5000)) / Math.log10(5000); // 0–1
  const partNorm      = Math.log10(clamp(particleSize, 1, 500)) / Math.log10(500); // 0–1
  const tempFactor    = (temperature - 10) / 70;           // 0–1

  // Base bowl RPM: 1500–4500
  let bowlRPM = lerp(1500, 4500,
    0.35 * densityFactor +
    0.30 * solidFactor +
    0.15 * (1 - viscNorm) +  // high viscosity → reduce RPM
    0.10 * (1 - partNorm) +  // large particles → reduce RPM
    0.10 * tempFactor
  );
  bowlRPM = clamp(bowlRPM, 800, 4500);

  // ── G-force ───────────────────────────────────────────────
  const bowlRadiusM = 0.25; // 250 mm bowl
  const omega = (bowlRPM * 2 * Math.PI) / 60;
  const gForce = (omega * omega * bowlRadiusM) / 9.81;

  // ── Scroll / conveyor speed (differential) ────────────────
  // High solids → faster scroll to transport cake
  // High viscosity → slower scroll
  // Large particles → faster scroll
  let scrollDiff = lerp(1, 35,
    0.40 * solidFactor +
    0.25 * (1 - viscNorm) +
    0.20 * partNorm +
    0.15 * densityFactor
  );
  scrollDiff = clamp(scrollDiff, 0.5, 35);
  const scrollRPM = bowlRPM - scrollDiff;  // scroll rotates slower

  // ── Adjusted flow rate ────────────────────────────────────
  // If solids are very high or viscosity is high, reduce feed rate
  const flowPenalty = 0.5 * solidFactor + 0.3 * viscNorm + 0.2 * (1 - partNorm);
  const adjustedFlow = clamp(flowRate * (1 - 0.4 * flowPenalty), 2, 200);

  // ── Torque estimates ──────────────────────────────────────
  const bowlTorque   = clamp(50 + densityFactor * 120 + solidFactor * 80, 50, 250);
  const scrollTorque = clamp(20 + solidFactor * 100 + (1 - partNorm) * 40, 20, 180);

  // ── Energy consumption (kW) ───────────────────────────────
  // P ≈ (T_bowl × ω_bowl + T_scroll × ω_scroll) / 1000 × efficiency
  const powerBowl   = (bowlTorque   * omega) / 1000;
  const omegaScroll = (scrollRPM * 2 * Math.PI) / 60;
  const powerScroll = (scrollTorque * omegaScroll) / 1000;
  const energy      = clamp((powerBowl + powerScroll) * 1.15, 2, 120); // 15% losses

  // ── Retention time (s) ────────────────────────────────────
  const bowlVolume  = Math.PI * Math.pow(bowlRadiusM, 2) * 1.2; // m³ approx
  const retentionTime = (bowlVolume / (adjustedFlow / 60000)) * 0.7;

  // ── Pool depth (mm) ───────────────────────────────────────
  const poolDepth = clamp(30 + (1 - partNorm) * 60 + densityFactor * 40, 20, 120);

  // ── Solids moisture (%) ───────────────────────────────────
  const solidsMoisture = clamp(
    5 + viscNorm * 25 + (1 - scrollDiff / 35) * 20 + (1 - gForce / 3000) * 15,
    5, 60
  );

  // ── Separation efficiency ─────────────────────────────────
  const efficiency = clamp(
    95 - solidsMoisture * 0.5 - (1 - partNorm) * 10 - viscNorm * 8,
    40, 99
  );

  // ── Model confidence ──────────────────────────────────────
  const inRange =
    (density >= 1.0 && density <= 1.8) &&
    (solidContent >= 5 && solidContent <= 55) &&
    (viscosity >= 1 && viscosity <= 3000) &&
    (flowRate >= 5 && flowRate <= 180);
  const confidence = inRange ? clamp(85 + Math.random() * 10, 85, 99) : clamp(55 + Math.random() * 20, 55, 75);

  // ── Alerts ────────────────────────────────────────────────
  if (solidContent > 50)  alerts.push('⚠ Feed solid content critically high – risk of scroll overload');
  if (viscosity > 3000)   alerts.push('⚠ Feed viscosity exceeds operational envelope');
  if (gForce > 2800)      alerts.push('⚠ G-force approaching mechanical limit');
  if (energy > 80)        alerts.push('⚠ Power draw elevated – check mechanical seals');
  if (solidsMoisture > 40) alerts.push('⚠ Predicted cake moisture high – adjust pond depth');
  if (adjustedFlow < flowRate * 0.7) alerts.push('⚠ Feed rate throttled to prevent bowl flooding');

  // ── Status ────────────────────────────────────────────────
  let status: ControlOutputs['status'] = 'OPTIMAL';
  if (alerts.length >= 3) status = 'CRITICAL';
  else if (alerts.length >= 1) status = 'WARNING';

  return {
    bowlSpeed: Math.round(bowlRPM),
    scrollSpeed: Math.round(scrollRPM),
    differentialSpeed: Math.round(scrollDiff * 10) / 10,
    adjustedFlowRate: Math.round(adjustedFlow * 10) / 10,
    energyConsumption: Math.round(energy * 10) / 10,
    bowlMotorTorque: Math.round(bowlTorque),
    scrollMotorTorque: Math.round(scrollTorque),
    separationEfficiency: Math.round(efficiency * 10) / 10,
    gForce: Math.round(gForce),
    poolDepth: Math.round(poolDepth),
    retentionTime: Math.round(retentionTime),
    solidsMoisture: Math.round(solidsMoisture * 10) / 10,
    confidence: Math.round(confidence),
    status,
    alerts,
  };
}

// ─── Trend generator (for sparklines / history) ──────────────
export function generateTrendHistory(
  baseFeed: FeedProperties,
  points: number = 60
): TrendPoint[] {
  const history: TrendPoint[] = [];
  const now = Date.now();
  for (let i = points - 1; i >= 0; i--) {
    const jitter = (v: number, pct: number) =>
      v * (1 + (Math.random() - 0.5) * pct);
    const noisyFeed: FeedProperties = {
      density:      jitter(baseFeed.density, 0.04),
      solidContent: jitter(baseFeed.solidContent, 0.06),
      viscosity:    jitter(baseFeed.viscosity, 0.08),
      particleSize: jitter(baseFeed.particleSize, 0.1),
      temperature:  jitter(baseFeed.temperature, 0.05),
      flowRate:     jitter(baseFeed.flowRate, 0.05),
    };
    const out = predict(noisyFeed);
    history.push({
      time:        now - i * 5000,
      bowlSpeed:   out.bowlSpeed,
      scrollSpeed: out.scrollSpeed,
      energy:      out.energyConsumption,
      flowRate:    out.adjustedFlowRate,
      gForce:      out.gForce,
      efficiency:  out.separationEfficiency,
    });
  }
  return history;
}
