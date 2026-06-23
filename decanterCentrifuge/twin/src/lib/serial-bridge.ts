'use client';

import type { ControlOutputs, FeedProperties, TrendPoint } from './predictive-engine';

// ─── Raw frame from the ESP32 firmware ─────────────────────────
export interface Esp32Telemetry {
  flowKgh: number;
  oilLevelCm: number;
  pomaceLevelCm: number;
  tempC: number;
  bowlRpm: number;
  screwRpm: number;
  bowlCurrentA: number;
  screwCurrentA: number;
  totalPowerW: number;
  specificEnergy: number;
  predictedEff: number;
  pumpOn: boolean;
  feedMode: string;
  pumpMode: string;
}

// ─── Connection state ──────────────────────────────────────────
export type SerialStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SerialState {
  status: SerialStatus;
  portInfo: string;
  lastData: Esp32Telemetry | null;
  error: string | null;
}

// ─── Parse a $DATA frame ───────────────────────────────────────
function parseFrame(line: string): Esp32Telemetry | null {
  const match = line.match(/^\$DATA,(.+)\*([0-9A-F]{2})$/);
  if (!match) return null;

  const fields = match[1].split(',');
  if (fields.length < 14) return null;

  // Checksum verification
  const payload = '$DATA,' + match[1];
  let calc = 0;
  for (let i = 1; i < payload.length; i++) calc ^= payload.charCodeAt(i);
  const received = parseInt(match[2], 16);
  if (calc !== received) return null;

  return {
    flowKgh:       parseFloat(fields[0]),
    oilLevelCm:    parseFloat(fields[1]),
    pomaceLevelCm: parseFloat(fields[2]),
    tempC:         parseFloat(fields[3]),
    bowlRpm:       parseFloat(fields[4]),
    screwRpm:      parseFloat(fields[5]),
    bowlCurrentA:  parseFloat(fields[6]),
    screwCurrentA: parseFloat(fields[7]),
    totalPowerW:   parseFloat(fields[8]),
    specificEnergy: parseFloat(fields[9]),
    predictedEff:  parseFloat(fields[10]),
    pumpOn:        fields[11] === '1',
    feedMode:      fields[12],
    pumpMode:      fields[13],
  };
}

// ─── Map telemetry to dashboard ControlOutputs ──────────────────
export function telemetryToOutputs(
  t: Esp32Telemetry,
  density: number,
): ControlOutputs {
  const bowlRadiusM = 0.25;
  const omega = (t.bowlRpm * 2 * Math.PI) / 60;
  const gForce = (omega * omega * bowlRadiusM) / 9.81;
  const diffSpeed = t.bowlRpm - t.screwRpm;

  const alerts: string[] = [];
  if (t.predictedEff < 85) alerts.push(`⚠ Oil recovery low (${t.predictedEff.toFixed(1)}%)`);
  if (t.bowlCurrentA > 3.0) alerts.push('⚠ Bowl motor current elevated');
  if (t.screwCurrentA > 2.0) alerts.push('⚠ Screw motor current elevated');
  if (t.tempC > 60) alerts.push('⚠ Temperature approaching limit');
  if (t.specificEnergy > 4.0) alerts.push('⚠ Specific energy above target');

  let status: ControlOutputs['status'] = 'OPTIMAL';
  if (alerts.length >= 3) status = 'CRITICAL';
  else if (alerts.length >= 1) status = 'WARNING';

  return {
    bowlSpeed: Math.round(t.bowlRpm),
    scrollSpeed: Math.round(t.screwRpm),
    differentialSpeed: Math.round(diffSpeed * 10) / 10,
    adjustedFlowRate: Math.round((t.flowKgh / (density * 60)) * 10) / 10,
    energyConsumption: Math.round((t.totalPowerW / 1000) * 10) / 10,
    bowlMotorTorque: Math.round((t.bowlCurrentA * 12 * 60) / (2 * Math.PI * Math.max(t.bowlRpm, 1)) * 10) / 10,
    scrollMotorTorque: Math.round((t.screwCurrentA * 12 * 60) / (2 * Math.PI * Math.max(t.screwRpm, 1)) * 10) / 10,
    separationEfficiency: Math.round(t.predictedEff * 10) / 10,
    gForce: Math.round(gForce),
    poolDepth: 50,
    retentionTime: 45,
    solidsMoisture: Math.round((5 + (100 - t.predictedEff) * 2) * 10) / 10,
    confidence: 95,
    status,
    alerts,
  };
}

export function telemetryToTrendPoint(t: Esp32Telemetry, density: number): TrendPoint {
  const bowlRadiusM = 0.25;
  const omega = (t.bowlRpm * 2 * Math.PI) / 60;
  const gForce = (omega * omega * bowlRadiusM) / 9.81;

  return {
    time: Date.now(),
    bowlSpeed: Math.round(t.bowlRpm),
    scrollSpeed: Math.round(t.screwRpm),
    energy: Math.round((t.totalPowerW / 1000) * 10) / 10,
    flowRate: Math.round((t.flowKgh / (density * 60)) * 10) / 10,
    gForce: Math.round(gForce),
    efficiency: Math.round(t.predictedEff * 10) / 10,
  };
}

// ─── Serial bridge class ───────────────────────────────────────
export class SerialBridge {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private abortController: AbortController | null = null;
  private buffer = '';

  onData: ((t: Esp32Telemetry) => void) | null = null;
  onStatus: ((s: SerialStatus, msg?: string) => void) | null = null;

  async connect(): Promise<void> {
    if (!('serial' in navigator)) {
      this.onStatus?.('error', 'Web Serial API not supported (use Chrome/Edge)');
      return;
    }

    try {
      this.onStatus?.('connecting');
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 115200 });

      // Acquire writer immediately for sending commands
      this.writer = this.port.writable!.getWriter();

      this.onStatus?.('connected', this.port.getInfo().usbProductId
        ? `USB device ${this.port.getInfo().usbVendorId}:${this.port.getInfo().usbProductId}`
        : 'Serial connected');

      this.abortController = new AbortController();
      this.startReading();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      this.onStatus?.('error', msg);
    }
  }

  private async startReading() {
    if (!this.port || !this.abortController) return;

    const decoder = new TextDecoderStream();
    const readable = this.port.readable;
    if (!readable) return;

    readable.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => {});
    this.reader = decoder.readable.getReader();

    try {
      while (this.abortController && !this.abortController.signal.aborted) {
        const { value, done } = await this.reader.read();
        if (done) break;

        this.buffer += value;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('$DATA,')) {
            const telemetry = parseFrame(trimmed);
            if (telemetry) {
              this.onData?.(telemetry);
            }
          } else if (trimmed.startsWith('$ACK') || trimmed.startsWith('$WARN') || trimmed.startsWith('$ERROR') || trimmed.startsWith('$INFO')) {
            console.log('[SerialBridge] ESP32:', trimmed);
          }
        }
      }
    } catch (err) {
      if (!this.abortController?.signal.aborted) {
        const msg = err instanceof Error ? err.message : 'Read error';
        this.onStatus?.('error', msg);
      }
    }

    this.cleanup();
  }

  async send(command: string): Promise<void> {
    if (!this.writer) {
      console.error('[SerialBridge] No writer available');
      return;
    }
    try {
      const encoder = new TextEncoder();
      await this.writer.write(encoder.encode(command + '\n'));
      console.log('[SerialBridge] Sent:', command);
    } catch (err) {
      console.error('[SerialBridge] Send error:', err);
    }
  }

  // ── Convenience commands ────────────────────────────────────
  async setSpeeds(bowlRpm: number, screwRpm: number): Promise<void> {
    await this.send(`SET:${Math.round(bowlRpm)},${Math.round(screwRpm)}`);
  }

  async setFeedPreset(preset: 'NOMINAL' | 'WATERY' | 'THICKER'): Promise<void> {
    await this.send(`FEED:${preset}`);
  }

  async setPump(on: boolean): Promise<void> {
    await this.send(on ? 'PUMP:ON' : 'PUMP:OFF');
  }

  async setBowl(on: boolean): Promise<void> {
    await this.send(on ? 'BOWL:ON' : 'BOWL:OFF');
  }

  async emergencyStop(): Promise<void> {
    await this.send('STOP');
  }

  async testBuzzer(): Promise<void> {
    await this.send('BUZZER:TEST');
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort();
    if (this.reader) {
      try { await this.reader.cancel(); } catch { /* ignore */ }
      this.reader = null;
    }
    if (this.writer) {
      try { await this.writer.close(); } catch { /* ignore */ }
      this.writer = null;
    }
    if (this.port) {
      try { await this.port.close(); } catch { /* ignore */ }
      this.port = null;
    }
    this.onStatus?.('disconnected');
  }

  private cleanup() {
    this.reader = null;
    this.writer = null;
  }
}
