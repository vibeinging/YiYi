/**
 * useVoiceInput — Click-to-toggle voice input with local Whisper STT
 *
 * Records audio via MediaRecorder, transcribes locally using
 * onnx-community/whisper-base (downloaded on first use, ~150MB).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import i18n from '../i18n';
import {
  getTranscriber,
  isModelLoaded,
  transcribe,
  audioToFloat32,
  type ModelProgress,
} from '../services/whisperSTT';

export type VoiceStatus = 'idle' | 'loading' | 'recording' | 'transcribing';

export interface UseVoiceInputReturn {
  status: VoiceStatus;
  modelProgress: number; // 0-100, meaningful when status === 'loading'
  toggleRecording: () => void;
  error: string | null;
}

export function useVoiceInput(
  onResult: (text: string) => void,
): UseVoiceInputReturn {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [modelProgress, setModelProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Preload model in the background on mount
  useEffect(() => {
    if (isModelLoaded()) return;
    getTranscriber().catch(() => {});
  }, []);

  const stopMediaStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);

    // Ensure model is loaded (show progress if first time)
    if (!isModelLoaded()) {
      setStatus('loading');
      try {
        await getTranscriber((p: ModelProgress) => {
          if (p.status === 'progress' && typeof p.progress === 'number') {
            setModelProgress(Math.round(p.progress));
          }
        });
      } catch {
        setError('modelLoadFailed');
        setStatus('idle');
        return;
      }
    }

    // Request microphone
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('permissionDenied');
      setStatus('idle');
      return;
    }
    streamRef.current = stream;

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      stopMediaStream();
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      if (blob.size === 0) {
        setStatus('idle');
        return;
      }

      setStatus('transcribing');
      try {
        const audio = await audioToFloat32(blob);
        const lang = i18n.language === 'zh' ? 'chinese' : 'english';
        const text = await transcribe(audio, lang);
        if (text) onResult(text);
      } catch {
        setError('transcribeFailed');
      }
      setStatus('idle');
    };

    recorder.start();
    setStatus('recording');
  }, [onResult, stopMediaStream]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (status === 'recording') {
      stopRecording();
    } else if (status === 'idle') {
      startRecording();
    }
    // Ignore clicks during loading/transcribing
  }, [status, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      stopMediaStream();
    };
  }, [stopMediaStream]);

  return { status, modelProgress, toggleRecording, error };
}
