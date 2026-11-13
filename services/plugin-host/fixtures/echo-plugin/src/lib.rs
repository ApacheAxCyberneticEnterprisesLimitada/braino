#![no_std]

extern crate alloc;

use alloc::{
    alloc::{alloc, handle_alloc_error, realloc, Layout},
    format,
    string::String,
};
use core::sync::atomic::{AtomicU32, Ordering};

#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
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

wit_bindgen::generate!({ world: "plugin", path: "../../../../packages/plugin-runtime/wit" });

use exports::braino::plugin::handler::Guest;

static CALLS: AtomicU32 = AtomicU32::new(0);

struct EchoPlugin;

impl Guest for EchoPlugin {
    fn invoke(capability: String, input_json: String) -> Result<String, String> {
        if input_json == r#"{"loop":true}"# {
            loop {
                CALLS.fetch_add(1, Ordering::SeqCst);
            }
        }
        let prefix = braino::plugin::host::configuration("prefix").unwrap_or_default();
        let token = braino::plugin::host::secret("token")?;
        let calls = CALLS.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(format!(
            r#"{{"value":"{prefix}:{token}:{capability}:{input_json}:{calls}"}}"#
        ))
    }
}

export!(EchoPlugin);
