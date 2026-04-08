/**
 * Speech processing interfaces for pronunciation assessment and transcription.
 */

/** Supported speech processing backends. */
export type SpeechBackend = 'azure' | 'whisper';

/** Result from a speech transcription/assessment. */
export interface SpeechResult {
  /** The transcribed text from the audio. */
  transcript: string;
  /** ISO language code detected or specified (e.g. "de-DE"). */
  language?: string;
  /**
   * Pronunciation assessment scores (only available with backends that support it, e.g. Azure).
   * All scores are 0–100.
   */
  pronunciation?: {
    /** Overall accuracy score. */
    accuracyScore: number;
    /** Fluency score. */
    fluencyScore: number;
    /** Completeness score. */
    completenessScore: number;
    /** Overall pronunciation score. */
    pronunciationScore: number;
    /** Per-word assessment details. */
    words?: WordAssessment[];
  };
}

export interface WordAssessment {
  word: string;
  accuracyScore: number;
  /** "None" | "Omission" | "Insertion" | "Mispronunciation" | "UnexpectedBreak" | "MissingBreak" | "Monotone" */
  errorType: string;
}

/** Configuration for the speech processing module. */
export interface SpeechConfig {
  /** Which backend to use. */
  backend: SpeechBackend;
  /** Default language for transcription (e.g. "de-DE", "zh-CN", "en-US"). */
  language?: string;
  /** Azure-specific configuration. */
  azure?: {
    subscriptionKey: string;
    region: string;
  };
  /** OpenAI Whisper-specific configuration. */
  whisper?: {
    apiKey: string;
    /** Model to use. Default: "whisper-1". */
    model?: string;
    /** Base URL override (for compatible APIs like Groq). */
    baseUrl?: string;
  };
}

/** Interface that all speech backends must implement. */
export interface SpeechProvider {
  /** Transcribe and optionally assess pronunciation of audio. */
  process(
    audio: Buffer,
    options?: {
      /** Target language. Overrides config default. */
      language?: string;
      /** Reference text for pronunciation assessment (if supported). */
      referenceText?: string;
      /** Detected MIME type of the audio (e.g. "audio/mp4", "audio/ogg"). */
      mime?: string;
      /** File extension hint (e.g. "m4a", "ogg"). */
      ext?: string;
    }
  ): Promise<SpeechResult>;
}
