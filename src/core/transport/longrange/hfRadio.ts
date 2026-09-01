import { Platform } from 'react-native';

/**
 * HF-транспорт (CAT/PTT по USB-serial; Xiegu G90, Yaesu FT-817 и т.п.).
 * Без нативного USB — режим `simulate`: очередь RX/TX, PTT и кодирование в «аудио» (PCM-подобные сэмплы).
 */
export type HFRadioConfig = {
  port: string;
  baudRate: number;
  frequency: number;
  mode: 'usb' | 'lsb';
  power: number;
  /** Включить программную эмуляцию без железа (очередь, FSK→PCM). */
  simulate?: boolean;
};

const HF_MAGIC = new Uint8Array([0x48, 0x46, 0x41, 0x43]); // "HFAC"

/** Кодирует байты в моно Int16 PCM-сэмплы (упрощённый FSK: два уровня амплитуды на бит). */
export function encodeBytesToAudioPcm(data: Uint8Array, sampleRate = 8000): Int16Array {
  const bits: number[] = [];
  for (let i = 0; i < HF_MAGIC.length; i++) bits.push(HF_MAGIC[i]!);
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
  }
  const samplesPerBit = Math.max(8, Math.floor(sampleRate / 300));
  const out = new Int16Array(bits.length * samplesPerBit);
  let o = 0;
  const hi = 12000;
  const lo = -12000;
  for (const bit of bits) {
    const v = bit ? hi : lo;
    for (let s = 0; s < samplesPerBit; s++) out[o++] = v;
  }
  return out;
}

/** Декодирует PCM обратно в байты (порог по среднему уровню). */
export function decodeAudioPcmToBytes(samples: Int16Array, sampleRate = 8000): Uint8Array | null {
  const samplesPerBit = Math.max(8, Math.floor(sampleRate / 300));
  const bits: number[] = [];
  for (let i = 0; i < samples.length; i += samplesPerBit) {
    let sum = 0;
    const n = Math.min(samplesPerBit, samples.length - i);
    for (let j = 0; j < n; j++) sum += samples[i + j] ?? 0;
    const bit = sum / n > 0 ? 1 : 0;
    bits.push(bit);
  }
  const needMagic = HF_MAGIC.length * 8;
  if (bits.length < needMagic + 8) return null;
  const magicBits = bits.slice(0, needMagic);
  for (let m = 0; m < HF_MAGIC.length; m++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | (magicBits[m * 8 + k] ?? 0);
    if (v !== HF_MAGIC[m]) return null;
  }
  const rest = bits.slice(needMagic);
  const bytes: number[] = [];
  for (let i = 0; i + 7 < rest.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | (rest[i + k] ?? 0);
    bytes.push(v);
  }
  return new Uint8Array(bytes);
}

export class HFRadioTransport {
  private port: unknown = null;
  private isConnected = false;
  private pttActive = false;
  private readonly config: HFRadioConfig;
  private readonly rxQueue: Uint8Array[] = [];
  private readonly simLoopback: boolean;

  constructor(config: HFRadioConfig) {
    this.config = { ...config };
    this.simLoopback = config.simulate === true;
  }

  /** PTT: «нажать» (CAT-заглушка: только флаг; реальное железо — RTS/DTR). */
  pushToTalkStart(): void {
    this.pttActive = true;
    if (this.config.simulate && __DEV__) {
      console.log('[HF] PTT ON (simulated)');
    }
  }

  pushToTalkStop(): void {
    this.pttActive = false;
    if (this.config.simulate && __DEV__) {
      console.log('[HF] PTT OFF (simulated)');
    }
  }

  isPttActive(): boolean {
    return this.pttActive;
  }

  async connect(): Promise<boolean> {
    void this.port;
    if (this.config.simulate) {
      this.isConnected = true;
      console.log('[HF] Connected (simulate): PCM FSK codec ready');
      return true;
    }
    if (Platform.OS !== 'android') {
      console.log('[HF] Only Android supports USB serial in this build');
      return false;
    }
    console.log('[HF] Wire UsbSerialPort + CAT commands for your radio (G90, FT-817, …)');
    this.isConnected = false;
    return false;
  }

  async send(data: Uint8Array): Promise<boolean> {
    if (!this.isConnected) return false;
    if (!this.pttActive && !this.config.simulate) {
      console.warn('[HF] PTT not active');
      return false;
    }
    const pcm = encodeBytesToAudioPcm(data);
    void pcm;
    if (this.simLoopback) {
      this.rxQueue.push(new Uint8Array(data));
    }
    return true;
  }

  async receive(): Promise<Uint8Array | null> {
    if (!this.isConnected) return null;
    const next = this.rxQueue.shift();
    return next ?? null;
  }

  /** Для тестов: положить пакет в RX как будто принят по эфиру. */
  injectReceive(data: Uint8Array): void {
    this.rxQueue.push(new Uint8Array(data));
  }

  /** Полный цикл: байты → PCM → байты (проверка кодека). */
  roundTripAudio(data: Uint8Array): Uint8Array | null {
    const pcm = encodeBytesToAudioPcm(data);
    return decodeAudioPcmToBytes(pcm);
  }
}
