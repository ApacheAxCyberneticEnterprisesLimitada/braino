#![no_std]

extern crate alloc;

use alloc::{
    alloc::{alloc, handle_alloc_error, realloc, Layout},
    format,
    string::{String, ToString},
    vec::Vec,
};
use serde::{Deserialize, Serialize};

#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}

#[unsafe(no_mangle)]
unsafe extern "C" fn memcmp(
    left: *const core::ffi::c_void,
    right: *const core::ffi::c_void,
    length: usize,
) -> i32 {
    let left = left.cast::<u8>();
    let right = right.cast::<u8>();
    for index in 0..length {
        let difference = i32::from(*left.add(index)) - i32::from(*right.add(index));
        if difference != 0 {
            return difference;
        }
    }
    0
}

#[unsafe(export_name = "cabi_realloc")]
unsafe extern "C" fn component_realloc(
    old_ptr: *mut u8,
    old_len: usize,
    align: usize,
    new_len: usize,
) -> *mut u8 {
    let layout = Layout::from_size_align_unchecked(old_len, align);
    let pointer = if old_len == 0 {
        alloc(Layout::from_size_align_unchecked(new_len, align))
    } else {
        realloc(old_ptr, layout, new_len)
    };
    if pointer.is_null() {
        handle_alloc_error(Layout::from_size_align_unchecked(new_len, align));
    }
    pointer
}

wit_bindgen::generate!({ world: "plugin", path: "../../packages/plugin-runtime/wit" });

use exports::braino::plugin::handler::Guest;

#[derive(Deserialize)]
struct EmbeddingInput {
    inputs: Vec<String>,
}

#[derive(Serialize)]
struct OllamaRequest<'a> {
    model: &'a str,
    input: &'a [String],
    truncate: bool,
}

#[derive(Deserialize)]
struct OllamaResponse {
    model: String,
    embeddings: Vec<Vec<f32>>,
}

#[derive(Serialize)]
struct EmbeddingOutput {
    model: String,
    dimensions: usize,
    vectors: Vec<Vec<f32>>,
}

struct OllamaEmbeddingPlugin;

impl Guest for OllamaEmbeddingPlugin {
    fn invoke(capability: String, input_json: String) -> Result<String, String> {
        if capability != "embedding.embed" {
            return Err("unsupported capability".to_string());
        }
        let input: EmbeddingInput = serde_json::from_str(&input_json)
            .map_err(|_| "embedding input is invalid".to_string())?;
        if input.inputs.is_empty() {
            return Err("embedding input is empty".to_string());
        }
        let model = braino::plugin::host::configuration("model")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "embeddinggemma".to_string());
        let dimensions = braino::plugin::host::configuration("dimensions")
            .unwrap_or_else(|| "768".to_string())
            .parse::<usize>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| "embedding dimensions are invalid".to_string())?;
        let body = serde_json::to_vec(&OllamaRequest {
            model: &model,
            input: &input.inputs,
            truncate: true,
        })
        .map_err(|_| "embedding request could not be encoded".to_string())?;
        let response = braino::plugin::host::request(&braino::plugin::host::HttpRequest {
            method: "POST".to_string(),
            url: "http://ollama:11434/api/embed".to_string(),
            headers: alloc::vec![("content-type".to_string(), "application/json".to_string())],
            body,
        })?;
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "Ollama embedding request failed ({})",
                response.status
            ));
        }
        let result: OllamaResponse = serde_json::from_slice(&response.body)
            .map_err(|_| "Ollama embedding response is invalid".to_string())?;
        if result.embeddings.len() != input.inputs.len()
            || result
                .embeddings
                .iter()
                .any(|vector| vector.len() != dimensions)
        {
            return Err("Ollama returned unexpected embedding dimensions".to_string());
        }
        serde_json::to_string(&EmbeddingOutput {
            model: format!("ollama:{}", result.model),
            dimensions,
            vectors: result.embeddings,
        })
        .map_err(|_| "embedding response could not be encoded".to_string())
    }
}

export!(OllamaEmbeddingPlugin);
