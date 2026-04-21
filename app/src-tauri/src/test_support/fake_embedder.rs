//! Deterministic 512-dimensional embedder for tests.
//!
//! Produces a vector derived from a stable hash of the input text. Same input
//! always maps to the same vector. No network, no ONNX, no model file.

use memme_embeddings::{EmbedError, Embedder};
use std::hash::{Hash, Hasher};

const DIMS: usize = 512;

pub struct FakeEmbedder;

impl FakeEmbedder {
    pub fn new() -> Self {
        Self
    }
}

impl Default for FakeEmbedder {
    fn default() -> Self {
        Self::new()
    }
}

impl Embedder for FakeEmbedder {
    fn embed(&self, text: &str) -> Result<Vec<f32>, EmbedError> {
        if text.is_empty() {
            return Err(EmbedError::InvalidInput("text is empty".into()));
        }
        let mut h = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut h);
        let seed = h.finish();

        let mut v = Vec::with_capacity(DIMS);
        let mut state = seed;
        for _ in 0..DIMS {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let scaled = ((state & 0xFFFFFF) as f32 / 16_777_216.0) * 2.0 - 1.0;
            v.push(scaled);
        }
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
        for x in v.iter_mut() {
            *x /= norm;
        }
        Ok(v)
    }

    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError> {
        texts.iter().map(|t| self.embed(t)).collect()
    }

    fn dimensions(&self) -> usize {
        DIMS
    }

    fn model_name(&self) -> &str {
        "fake"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_embedder_returns_512_dim_vector() {
        let e = FakeEmbedder::new();
        let v = e.embed("hello").unwrap();
        assert_eq!(v.len(), DIMS);
        assert_eq!(e.dimensions(), DIMS);
    }

    #[test]
    fn fake_embedder_is_deterministic_for_same_input() {
        let e = FakeEmbedder::new();
        let a = e.embed("some text").unwrap();
        let b = e.embed("some text").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn fake_embedder_returns_different_vectors_for_different_inputs() {
        let e = FakeEmbedder::new();
        let a = e.embed("foo").unwrap();
        let b = e.embed("bar").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn fake_embedder_rejects_empty_string() {
        let e = FakeEmbedder::new();
        assert!(e.embed("").is_err());
    }

    #[test]
    fn fake_embedder_vector_is_l2_normalized() {
        let e = FakeEmbedder::new();
        let v = e.embed("anything").unwrap();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "got norm {}", norm);
    }

    #[test]
    fn fake_embedder_batch_matches_sequential_calls() {
        let e = FakeEmbedder::new();
        let batch = e.embed_batch(&["a", "b", "c"]).unwrap();
        assert_eq!(batch.len(), 3);
        assert_eq!(batch[0], e.embed("a").unwrap());
        assert_eq!(batch[1], e.embed("b").unwrap());
        assert_eq!(batch[2], e.embed("c").unwrap());
    }
}
