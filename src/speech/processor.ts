/**
 * Speech processor — factory that creates the configured backend
 * and provides a unified audio processing interface.
 */

import type { SpeechConfig, SpeechProvider, SpeechResult } from './types.js';
import { AzureProvider } from './azure.js';
import { WhisperProvider } from './whisper.js';
import { logger } from '../utils/logger.js';

const log = logger('speech');

export interface AudioFormat {
  mime: string;
  ext: string;
}

/** Detect audio format from buffer magic bytes. */
export function detectAudioFormat(buf: Buffer): AudioFormat {
  if (buf.length < 12) return { mime: 'application/octet-stream', ext: 'bin' };

  // OGG (often Opus from Feishu voice messages)
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return { mime: 'audio/ogg', ext: 'ogg' };
  }
  // RIFF header (WAV)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) {
    return { mime: 'audio/wav', ext: 'wav' };
  }
  // ftyp box (M4A / MP4)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return { mime: 'audio/mp4', ext: 'm4a' };
  }
  // MP3 (ID3 tag or sync word)
  if (
    (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  ) {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  // AMR
  if (buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x41 && buf[3] === 0x4d && buf[4] === 0x52) {
    return { mime: 'audio/amr', ext: 'amr' };
  }
  // FLAC
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) {
    return { mime: 'audio/flac', ext: 'flac' };
  }

  return { mime: 'application/octet-stream', ext: 'bin' };
}

export class SpeechProcessor {
  private readonly provider: SpeechProvider;
  private readonly config: SpeechConfig;

  constructor(config: SpeechConfig) {
    this.config = config;

    switch (config.backend) {
      case 'azure':
        this.provider = new AzureProvider(config);
        break;
      case 'whisper':
        this.provider = new WhisperProvider(config);
        break;
      default:
        throw new Error(`Unknown speech backend: "${config.backend}"`);
    }

    log.info(`Speech processor initialized with backend: ${config.backend}`);
  }

  /**
   * Process an audio buffer: transcribe and optionally assess pronunciation.
   * Audio format is auto-detected from buffer magic bytes unless overridden.
   */
  async process(
    audio: Buffer,
    options?: { language?: string; referenceText?: string; mime?: string; ext?: string }
  ): Promise<SpeechResult> {
    const fmt = detectAudioFormat(audio);
    const mime = options?.mime ?? fmt.mime;
    const ext = options?.ext ?? fmt.ext;
    log.info(`Audio format: ${mime} (.${ext})`);
    return this.provider.process(audio, { ...options, mime, ext });
  }

  /**
   * Format a SpeechResult into a human-readable text block for injection
   * into the conversation context.
   */
  static formatResult(result: SpeechResult): string {
    const lines: string[] = [];
    lines.push(`[Speech Transcription Result]`);
    lines.push(`Transcript: "${result.transcript}"`);
    if (result.language) lines.push(`Language: ${result.language}`);

    if (result.pronunciation) {
      const p = result.pronunciation;
      lines.push('');
      lines.push('[Pronunciation Assessment]');
      lines.push(`Overall Score: ${p.pronunciationScore}/100`);
      lines.push(`Accuracy: ${p.accuracyScore}/100`);
      lines.push(`Fluency: ${p.fluencyScore}/100`);
      lines.push(`Completeness: ${p.completenessScore}/100`);

      if (p.words && p.words.length > 0) {
        lines.push('');
        lines.push('Word Details:');
        for (const w of p.words) {
          const status = w.errorType === 'None' ? `${w.accuracyScore}/100` : `${w.errorType} (${w.accuracyScore}/100)`;
          lines.push(`  - "${w.word}": ${status}`);
        }
      }
    }

    return lines.join('\n');
  }

  get backend(): string {
    return this.config.backend;
  }
}
