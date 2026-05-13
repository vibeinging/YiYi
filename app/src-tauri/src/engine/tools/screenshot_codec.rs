//! Screenshot re-encoding helper.
//!
//! macOS `screencapture` and Chrome headless `--screenshot=` both emit PNG.
//! PNG of a typical 1280×800 desktop is ~600–800 KB → ~1500 LLM tokens after
//! base64+vision-tokenizer. JPEG quality 85 cuts that by ~60% with no
//! perceptible difference for UI screenshots.
//!
//! This module is the single re-encode point. Both screenshot tools call
//! [`png_bytes_to_jpeg_data_uri`]; if encoding fails for any reason (corrupt
//! PNG, unsupported color depth, etc.) we transparently fall back to the
//! original PNG bytes so callers never see an error.
//!
//! Used by:
//!   * `system_tools::desktop_screenshot_tool` (macOS screencapture)
//!   * `cheap_browser` (Chrome headless --screenshot)
//!
//! Quality is intentionally a module-level constant: changing it requires a
//! code review since it affects every screenshot LLM call.

use base64::Engine;

/// JPEG quality used for screenshot re-encoding. 85 is the sweet spot for
/// UI captures — anything lower and small fonts blur; higher gains few bytes.
pub const JPEG_QUALITY: u8 = 85;

/// Re-encode raw PNG bytes as JPEG quality-85 and return a `data:` URI.
/// Falls back to the original PNG data-URI on any decode/encode failure so
/// the caller can rely on getting *some* renderable image.
pub fn png_bytes_to_jpeg_data_uri(png_bytes: &[u8]) -> String {
    match re_encode(png_bytes) {
        Ok(jpeg) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
            format!("data:image/jpeg;base64,{}", b64)
        }
        Err(e) => {
            log::warn!(
                "screenshot_codec: JPEG re-encode failed ({}), falling back to PNG",
                e
            );
            let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);
            format!("data:image/png;base64,{}", b64)
        }
    }
}

fn re_encode(png_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)
        .map_err(|e| format!("png decode: {e}"))?;
    // JPEG can't store alpha; flatten to RGB.
    let rgb = img.to_rgb8();
    let mut out = Vec::with_capacity(png_bytes.len() / 3);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    encoder
        .encode_image(&rgb)
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal 2×2 PNG: full alpha, three primary colors + white.
    fn tiny_png() -> Vec<u8> {
        let mut buf = Vec::new();
        let img = image::ImageBuffer::from_fn(2, 2, |x, y| match (x, y) {
            (0, 0) => image::Rgba([255u8, 0, 0, 255]),
            (1, 0) => image::Rgba([0, 255, 0, 255]),
            (0, 1) => image::Rgba([0, 0, 255, 255]),
            _ => image::Rgba([255, 255, 255, 255]),
        });
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    }

    #[test]
    fn round_trips_png_to_jpeg_data_uri() {
        let uri = png_bytes_to_jpeg_data_uri(&tiny_png());
        assert!(uri.starts_with("data:image/jpeg;base64,"));
        // base64 chunk should decode back to a real JPEG (SOI marker FF D8).
        let payload = &uri["data:image/jpeg;base64,".len()..];
        let bytes = base64::engine::general_purpose::STANDARD.decode(payload).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "missing JPEG SOI marker");
    }

    #[test]
    fn re_encoded_jpeg_is_smaller_for_typical_screenshot() {
        // Build a 256×256 gradient — representative of UI content.
        let img = image::ImageBuffer::from_fn(256, 256, |x, y| {
            image::Rgba([x as u8, y as u8, ((x ^ y) & 0xFF) as u8, 255])
        });
        let mut png_buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png_buf), image::ImageFormat::Png)
            .unwrap();

        let uri = png_bytes_to_jpeg_data_uri(&png_buf);
        let payload = &uri["data:image/jpeg;base64,".len()..];
        let jpeg = base64::engine::general_purpose::STANDARD.decode(payload).unwrap();
        assert!(
            jpeg.len() < png_buf.len(),
            "JPEG q85 ({} bytes) should beat PNG ({} bytes) for non-trivial images",
            jpeg.len(),
            png_buf.len(),
        );
    }

    #[test]
    fn falls_back_to_png_on_corrupt_input() {
        let bogus = b"definitely not a PNG";
        let uri = png_bytes_to_jpeg_data_uri(bogus);
        // Caller asked for "screenshot data" — we return *something* renderable.
        // Fallback path keeps the original bytes under the PNG MIME so the
        // browser/LLM can still decide to display or reject — never errors.
        assert!(uri.starts_with("data:image/png;base64,"));
    }
}
