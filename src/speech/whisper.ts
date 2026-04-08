/**
 * OpenAI Whisper speech-to-text backend.
 *
 * Uses the OpenAI /v1/audio/transcriptions endpoint.
 * Compatible with any OpenAI-compatible API (e.g. Groq, local Whisper servers).
 */

import type { SpeechConfig, SpeechProvider, SpeechResult } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger('speech:whisper');

export class WhisperProvider implements SpeechProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly defaultLanguage?: string;

  constructor(config: SpeechConfig) {
    if (!config.whisper?.apiKey) {
      throw new Error('Whisper backend requires whisper.apiKey in speech config');
    }
    this.apiKey = config.whisper.apiKey;
    this.model = config.whisper.model ?? 'whisper-1';
    this.baseUrl = (config.whisper.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.defaultLanguage = config.language;
  }

  async process(
    audio: Buffer,
    options?: { language?: string; referenceText?: string; mime?: string; ext?: string }
  ): Promise<SpeechResult> {
    const language = options?.language ?? this.defaultLanguage;
    const mime = options?.mime ?? 'audio/mp4';
    const ext = options?.ext ?? 'm4a';

    // Build multipart form data manually (no external dependency)
    const boundary = `----NeoClaw${Date.now()}`;
    const parts: Buffer[] = [];

    const addField = (name: string, value: string) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        )
      );
    };

    // Audio file part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`
      )
    );
    parts.push(audio);
    parts.push(Buffer.from('\r\n'));

    addField('model', this.model);
    addField('response_format', 'verbose_json');
    if (language) {
      // Whisper expects ISO-639-1 (e.g. "de", "zh", "en")
      addField('language', language.split('-')[0]);
    }
    if (options?.referenceText) {
      addField('prompt', options.referenceText);
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    log.info(`Sending audio (${audio.length} bytes) to Whisper, model=${this.model}`);

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Whisper API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      text: string;
      language?: string;
      segments?: Array<{ text: string }>;
    };

    log.info(`Whisper transcription complete: "${data.text.slice(0, 100)}..."`);

    return {
      transcript: data.text,
      language: data.language ?? language,
    };
  }
}
