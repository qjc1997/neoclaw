/**
 * Microsoft Azure Speech Services backend.
 *
 * Supports both transcription and pronunciation assessment.
 * Uses the Azure Cognitive Services REST API directly (no SDK dependency).
 */

import type {
  SpeechConfig,
  SpeechProvider,
  SpeechResult,
  WordAssessment,
} from './types.js';
import { logger } from '../utils/logger.js';

const log = logger('speech:azure');

export class AzureProvider implements SpeechProvider {
  private readonly subscriptionKey: string;
  private readonly region: string;
  private readonly defaultLanguage: string;

  constructor(config: SpeechConfig) {
    if (!config.azure?.subscriptionKey || !config.azure?.region) {
      throw new Error('Azure backend requires azure.subscriptionKey and azure.region in speech config');
    }
    this.subscriptionKey = config.azure.subscriptionKey;
    this.region = config.azure.region;
    this.defaultLanguage = config.language ?? 'en-US';
  }

  async process(
    audio: Buffer,
    options?: { language?: string; referenceText?: string; mime?: string; ext?: string }
  ): Promise<SpeechResult> {
    const language = options?.language ?? this.defaultLanguage;

    const mime = options?.mime ?? 'audio/mp4';

    // If reference text is provided, use pronunciation assessment
    if (options?.referenceText) {
      return this._assessPronunciation(audio, language, options.referenceText, mime);
    }

    // Otherwise, just transcribe
    return this._transcribe(audio, language, mime);
  }

  private async _transcribe(audio: Buffer, language: string, mime?: string): Promise<SpeechResult> {
    const url = `https://${this.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${language}&format=detailed`;

    log.info(`Azure transcription: ${audio.length} bytes, language=${language}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.subscriptionKey,
        'Content-Type': mime,
        Accept: 'application/json',
      },
      body: audio,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Azure STT error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      RecognitionStatus: string;
      DisplayText?: string;
      NBest?: Array<{ Display: string; Confidence: number }>;
    };

    if (data.RecognitionStatus !== 'Success') {
      log.warn(`Azure STT status: ${data.RecognitionStatus}`);
      return { transcript: '', language };
    }

    const transcript = data.NBest?.[0]?.Display ?? data.DisplayText ?? '';
    log.info(`Azure transcription: "${transcript.slice(0, 100)}..."`);

    return { transcript, language };
  }

  private async _assessPronunciation(
    audio: Buffer,
    language: string,
    referenceText: string,
    mime?: string
  ): Promise<SpeechResult> {
    const pronunciationConfig = {
      ReferenceText: referenceText,
      GradingSystem: 'HundredMark',
      Granularity: 'Word',
      Dimension: 'Comprehensive',
      EnableMiscue: true,
    };

    const url = `https://${this.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${language}&format=detailed`;

    log.info(
      `Azure pronunciation assessment: ${audio.length} bytes, language=${language}, ref="${referenceText.slice(0, 50)}"`
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.subscriptionKey,
        'Content-Type': mime ?? 'audio/mp4',
        Accept: 'application/json',
        'Pronunciation-Assessment': Buffer.from(
          JSON.stringify(pronunciationConfig)
        ).toString('base64'),
      },
      body: audio,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Azure pronunciation assessment error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      RecognitionStatus: string;
      DisplayText?: string;
      NBest?: Array<{
        Display: string;
        PronunciationAssessment?: {
          AccuracyScore: number;
          FluencyScore: number;
          CompletenessScore: number;
          PronScore: number;
        };
        Words?: Array<{
          Word: string;
          PronunciationAssessment?: {
            AccuracyScore: number;
            ErrorType: string;
          };
        }>;
      }>;
    };

    if (data.RecognitionStatus !== 'Success') {
      log.warn(`Azure pronunciation status: ${data.RecognitionStatus}`);
      return { transcript: '', language };
    }

    const best = data.NBest?.[0];
    const transcript = best?.Display ?? data.DisplayText ?? '';

    const result: SpeechResult = { transcript, language };

    if (best?.PronunciationAssessment) {
      const pa = best.PronunciationAssessment;
      const words: WordAssessment[] =
        best.Words?.map((w) => ({
          word: w.Word,
          accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? 0,
          errorType: w.PronunciationAssessment?.ErrorType ?? 'None',
        })) ?? [];

      result.pronunciation = {
        accuracyScore: pa.AccuracyScore,
        fluencyScore: pa.FluencyScore,
        completenessScore: pa.CompletenessScore,
        pronunciationScore: pa.PronScore,
        words,
      };
    }

    log.info(
      `Azure assessment complete: score=${result.pronunciation?.pronunciationScore ?? 'N/A'}`
    );

    return result;
  }
}
