#[path = "../../../src-tauri/src/remote/terminal_bytes.rs"]
mod terminal_bytes;
use std::{hint::black_box, time::Instant};

fn measure(mut operation: impl FnMut(), iterations: u32) -> f64 {
    for _ in 0..100 {
        operation();
    }
    let started = Instant::now();
    for _ in 0..iterations {
        operation();
    }
    started.elapsed().as_secs_f64() * 1_000_000.0 / f64::from(iterations)
}

fn main() {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    println!(
        "CPU AVX2 available: {}",
        std::arch::is_x86_feature_detected!("avx2")
    );
    for (name, line) in [
        ("ascii", "abcdefghijklmnopqrstuvwxyz0123456789"),
        ("ansi-crlf", "\x1b[32m中文✓\x1b[0m value=123456789\r\n"),
    ] {
        let mut body = line
            .repeat(terminal_bytes::FRAME_PAYLOAD_BYTES / line.len() + 1)
            .into_bytes();
        body.truncate(terminal_bytes::FRAME_PAYLOAD_BYTES);
        let mut frame = terminal_bytes::new_frame(0, &body);
        let scalar =
            measure(
                || {
                    black_box(black_box(&body).iter().enumerate().any(|(index, byte)| {
                        *byte == b'\r' && body.get(index + 1) != Some(&b'\n')
                    }));
                },
                5000,
            );
        let simd = measure(
            || terminal_bytes::annotate_frame(black_box(&mut frame)),
            5000,
        );
        let old_copy = measure(
            || {
                let batch = black_box(&body).to_vec();
                black_box(terminal_bytes::new_frame(0, black_box(&batch)));
            },
            5000,
        );
        let new_copy = measure(
            || {
                black_box(terminal_bytes::new_frame(0, black_box(&body)));
            },
            5000,
        );
        println!("{{\"case\":\"{name}\",\"bytes\":{},\"scalarScanUs\":{scalar:.3},\"dispatchedScanUs\":{simd:.3},\"twoCopiesUs\":{old_copy:.3},\"oneCopyUs\":{new_copy:.3}}}", body.len());
    }
}
