/**
 * whisperSTT — Local speech-to-text via Whisper (onnx-community/whisper-base)
 *
 * Singleton pipeline: first call downloads the model (~150MB, cached in browser),
 * subsequent calls reuse it instantly.
 */

import { pipeline, type PipelineType } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/whisper-base';

export interface ModelProgress {
  status: 'initiate' | 'download' | 'progress' | 'done' | 'ready';
  file?: string;
  progress?: number;  // 0-100
}

export type ProgressCallback = (progress: ModelProgress) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriber: any = null;
let loadPromise: Promise<typeof transcriber> | null = null;

export async function getTranscriber(onProgress?: ProgressCallback) {
  if (transcriber) return transcriber;
  if (loadPromise) return loadPromise;

  loadPromise = pipeline('automatic-speech-recognition' as PipelineType, MODEL_ID, {
    progress_callback: onProgress,
  });

  try {
    transcriber = await loadPromise;
  } finally {
    loadPromise = null;
  }
  return transcriber;
}

export function isModelLoaded(): boolean {
  return !!transcriber;
}

/**
 * Transcribe a Float32Array of 16kHz mono audio.
 */
export async function transcribe(
  audio: Float32Array,
  language: string = 'chinese',
): Promise<string> {
  const t = await getTranscriber();
  const result = await t(audio, {
    language,
    task: 'transcribe',
  });
  return (result as { text: string }).text?.trim() || '';
}

/**
 * Convert an audio Blob (from MediaRecorder) to 16kHz mono Float32Array.
 */
export async function audioToFloat32(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext({ sampleRate: 16000 });

  try {
    // Try direct decode at 16kHz (works in most browsers)
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    if (audioBuffer.numberOfChannels === 1 && audioBuffer.sampleRate === 16000) {
      return audioBuffer.getChannelData(0);
    }

    // Resample via OfflineAudioContext
    const duration = audioBuffer.duration;
    const targetLength = Math.ceil(duration * 16000);
    const offlineCtx = new OfflineAudioContext(1, targetLength, 16000);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start();
    const resampled = await offlineCtx.startRendering();
    return resampled.getChannelData(0);
  } finally {
    await audioCtx.close();
  }
}
