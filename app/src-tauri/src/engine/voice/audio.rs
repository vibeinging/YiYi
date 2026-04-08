//! Audio I/O pipeline: microphone capture and speaker playback with sample-rate conversion.
//!
//! All audio is exchanged as **mono PCM16 @ 24 kHz** — the format expected by the
//! OpenAI Realtime API.  cpal callbacks run on OS audio threads; we bridge to the
//! async world via bounded `mpsc` channels.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::Resampler;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// PCM16 mono chunk at 24 kHz (~20 ms = 480 samples).
const CHUNK_SAMPLES: usize = 480;
/// Target sample rate for the OpenAI Realtime API.
const TARGET_RATE: u32 = 24_000;

/// The audio pipeline holds cpal streams (which are !Send).
/// Use `AudioPipeline::new()` from a blocking thread — it returns
/// Send-safe channel endpoints and keeps the streams alive internally.
struct AudioPipelineInner {
    cancel: Arc<AtomicBool>,
    _input_stream: cpal::Stream,
    _output_stream: cpal::Stream,
}

impl Drop for AudioPipelineInner {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// Channels returned from audio pipeline creation.
pub type AudioChannels = (
    std::sync::mpsc::Receiver<Vec<i16>>,   // mic_rx
    std::sync::mpsc::SyncSender<Vec<i16>>, // speaker_tx
);

/// Create a new audio pipeline.  Spawns a dedicated thread that creates and
/// owns the cpal streams (which are `!Send`).  Returns Send-safe channel endpoints.
/// The pipeline lives until `cancel` is set.
pub fn new(cancel: Arc<AtomicBool>) -> Result<AudioChannels, String> {
    // Use a oneshot channel to get the result from the audio thread
    let (result_tx, result_rx) =
        std::sync::mpsc::sync_channel::<Result<AudioChannels, String>>(1);

    let cancel_thread = cancel.clone();
    std::thread::Builder::new()
        .name("voice-audio-pipeline".into())
        .spawn(move || {
            let result = create_pipeline_on_thread(cancel_thread.clone());
            match result {
                Ok((mic_rx, speaker_tx, input_stream, output_stream)) => {
                    // Send the channels back to the caller
                    let _ = result_tx.send(Ok((mic_rx, speaker_tx)));

                    // Keep the streams alive until cancelled
                    let _inner = AudioPipelineInner {
                        cancel: cancel_thread.clone(),
                        _input_stream: input_stream,
                        _output_stream: output_stream,
                    };
                    while !cancel_thread.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
                Err(e) => {
                    let _ = result_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| format!("Audio thread spawn error: {e}"))?;

    // Wait for the audio thread to finish initialization
    result_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Audio pipeline initialization timed out".to_string())?
}

/// Create streams on the current thread (must stay on this thread).
fn create_pipeline_on_thread(
    cancel: Arc<AtomicBool>,
) -> Result<
    (
        std::sync::mpsc::Receiver<Vec<i16>>,
        std::sync::mpsc::SyncSender<Vec<i16>>,
        cpal::Stream,
        cpal::Stream,
    ),
    String,
> {
    let host = cpal::default_host();

    // ── Microphone (input) ──────────────────────────────────────────
    let input_device = host
        .default_input_device()
        .ok_or("No input device available")?;
    let input_config = input_device
        .default_input_config()
        .map_err(|e| format!("Input config error: {e}"))?;
    let input_rate = input_config.sample_rate().0;
    let input_channels = input_config.channels() as usize;

    log::info!(
        "Audio input: {} @ {}Hz, {} ch",
        input_device.name().unwrap_or_default(),
        input_rate,
        input_channels,
    );

    let (mic_tx, mic_rx) = std::sync::mpsc::sync_channel::<Vec<i16>>(100);
    let input_stream = build_input_stream(
        &input_device,
        &input_config,
        input_rate,
        input_channels,
        mic_tx,
        cancel.clone(),
    )?;
    input_stream
        .play()
        .map_err(|e| format!("Input play error: {e}"))?;

    // ── Speaker (output) ────────────────────────────────────────────
    let output_device = host
        .default_output_device()
        .ok_or("No output device available")?;
    let output_config = output_device
        .default_output_config()
        .map_err(|e| format!("Output config error: {e}"))?;
    let output_rate = output_config.sample_rate().0;
    let output_channels = output_config.channels() as usize;

    log::info!(
        "Audio output: {} @ {}Hz, {} ch",
        output_device.name().unwrap_or_default(),
        output_rate,
        output_channels,
    );

    let (speaker_tx, speaker_rx) = std::sync::mpsc::sync_channel::<Vec<i16>>(100);
    let output_stream = build_output_stream(
        &output_device,
        &output_config,
        output_rate,
        output_channels,
        speaker_rx,
        cancel,
    )?;
    output_stream
        .play()
        .map_err(|e| format!("Output play error: {e}"))?;

    Ok((mic_rx, speaker_tx, input_stream, output_stream))
}

// ─── Input stream builder ───────────────────────────────────────────────────

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    device_rate: u32,
    channels: usize,
    tx: std::sync::mpsc::SyncSender<Vec<i16>>,
    cancel: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let need_resample = device_rate != TARGET_RATE;
    let resampler: Option<Arc<std::sync::Mutex<rubato::SincFixedIn<f32>>>> = if need_resample {
        Some(Arc::new(std::sync::Mutex::new(
            rubato::SincFixedIn::<f32>::new(
                TARGET_RATE as f64 / device_rate as f64,
                1.0,
                rubato::SincInterpolationParameters {
                    sinc_len: 64,
                    f_cutoff: 0.95,
                    oversampling_factor: 32,
                    interpolation: rubato::SincInterpolationType::Cubic,
                    window: rubato::WindowFunction::BlackmanHarris2,
                },
                1024,
                1,
            )
            .map_err(|e| format!("Resampler init error: {e}"))?,
        )))
    } else {
        None
    };

    let acc = Arc::new(std::sync::Mutex::new(Vec::<i16>::with_capacity(CHUNK_SAMPLES * 2)));

    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.clone().into();
    let err_fn = |e: cpal::StreamError| log::error!("Audio input error: {e}");

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                    .collect();

                let resampled: Vec<f32> = if let Some(ref rs) = resampler {
                    let mut rs = rs.lock().unwrap();
                    let input = vec![mono];
                    match rs.process(&input, None) {
                        Ok(out) => out.into_iter().next().unwrap_or_default(),
                        Err(_) => return,
                    }
                } else {
                    mono
                };

                let pcm16: Vec<i16> = resampled
                    .iter()
                    .map(|s: &f32| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                    .collect();

                let mut buf = acc.lock().unwrap();
                buf.extend_from_slice(&pcm16);
                while buf.len() >= CHUNK_SAMPLES {
                    let chunk: Vec<i16> = buf.drain(..CHUNK_SAMPLES).collect();
                    let _ = tx.try_send(chunk);
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let mono_f32: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| {
                        frame.iter().map(|&s| s as f32 / i16::MAX as f32).sum::<f32>()
                            / channels as f32
                    })
                    .collect();

                let resampled: Vec<f32> = if let Some(ref rs) = resampler {
                    let mut rs = rs.lock().unwrap();
                    match rs.process(&vec![mono_f32], None) {
                        Ok(out) => out.into_iter().next().unwrap_or_default(),
                        Err(_) => return,
                    }
                } else {
                    mono_f32
                };

                let pcm16: Vec<i16> = resampled
                    .iter()
                    .map(|s: &f32| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                    .collect();

                let mut buf = acc.lock().unwrap();
                buf.extend_from_slice(&pcm16);
                while buf.len() >= CHUNK_SAMPLES {
                    let chunk: Vec<i16> = buf.drain(..CHUNK_SAMPLES).collect();
                    let _ = tx.try_send(chunk);
                }
            },
            err_fn,
            None,
        ),
        _ => return Err(format!("Unsupported sample format: {sample_format:?}")),
    };

    stream.map_err(|e| format!("Build input stream error: {e}"))
}

// ─── Output stream builder ──────────────────────────────────────────────────

fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    device_rate: u32,
    channels: usize,
    rx: std::sync::mpsc::Receiver<Vec<i16>>,
    cancel: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let need_resample = device_rate != TARGET_RATE;
    let resampler: Option<Arc<std::sync::Mutex<rubato::SincFixedIn<f32>>>> = if need_resample {
        Some(Arc::new(std::sync::Mutex::new(
            rubato::SincFixedIn::<f32>::new(
                device_rate as f64 / TARGET_RATE as f64,
                1.0,
                rubato::SincInterpolationParameters {
                    sinc_len: 64,
                    f_cutoff: 0.95,
                    oversampling_factor: 32,
                    interpolation: rubato::SincInterpolationType::Cubic,
                    window: rubato::WindowFunction::BlackmanHarris2,
                },
                CHUNK_SAMPLES,
                1,
            )
            .map_err(|e| format!("Output resampler init error: {e}"))?,
        )))
    } else {
        None
    };

    // Ring buffer fed by the rx channel
    let ring = Arc::new(std::sync::Mutex::new(
        std::collections::VecDeque::<f32>::with_capacity(4096),
    ));

    // Drain incoming audio into the ring buffer on a separate thread
    let ring_for_feeder = ring.clone();
    let cancel_feeder = cancel.clone();
    std::thread::Builder::new()
        .name("voice-speaker-feeder".into())
        .spawn(move || {
            while !cancel_feeder.load(Ordering::Relaxed) {
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(pcm16) => {
                        let f32_samples: Vec<f32> = pcm16
                            .iter()
                            .map(|&s| s as f32 / i16::MAX as f32)
                            .collect();

                        let output_samples: Vec<f32> = if let Some(ref rs) = resampler {
                            let mut rs = rs.lock().unwrap();
                            match rs.process(&vec![f32_samples], None) {
                                Ok(out) => out.into_iter().next().unwrap_or_default(),
                                Err(_) => continue,
                            }
                        } else {
                            f32_samples
                        };

                        let mut buf = ring_for_feeder.lock().unwrap();
                        // Cap at ~1 second of audio to prevent unbounded growth
                        if buf.len() < 48_000 {
                            buf.extend(output_samples);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .ok();

    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.clone().into();
    let err_fn = |e: cpal::StreamError| log::error!("Audio output error: {e}");

    let ring_for_f32 = ring.clone();
    let ring_for_i16 = ring.clone();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &stream_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                if cancel.load(Ordering::Relaxed) {
                    data.fill(0.0);
                    return;
                }
                let mut buf = ring_for_f32.lock().unwrap();
                for frame in data.chunks_mut(channels) {
                    let sample = buf.pop_front().unwrap_or(0.0);
                    for s in frame.iter_mut() {
                        *s = sample;
                    }
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            &stream_config,
            move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                if cancel.load(Ordering::Relaxed) {
                    data.fill(0);
                    return;
                }
                let mut buf = ring_for_i16.lock().unwrap();
                for frame in data.chunks_mut(channels) {
                    let sample = buf.pop_front().unwrap_or(0.0);
                    let i16_sample = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    for s in frame.iter_mut() {
                        *s = i16_sample;
                    }
                }
            },
            err_fn,
            None,
        ),
        _ => return Err(format!("Unsupported output sample format: {sample_format:?}")),
    };

    stream.map_err(|e| format!("Build output stream error: {e}"))
}
