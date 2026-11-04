//! Byte-only framing. ANSI/UTF-8 parsing remains owned by xterm's streaming parser.
pub const FRAME_PAYLOAD_BYTES: usize = 64 * 1024;
pub const FRAME_METADATA: u8 = 0x80;
pub const FRAME_BARE_CR: u8 = 0x04;

pub fn new_frame(kind: u8, bytes: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(bytes.len() + 1);
    frame.push(kind);
    frame.extend_from_slice(bytes);
    frame
}

pub fn annotate_frame(frame: &mut [u8]) {
    let body = &frame[1..];
    let bare_cr = has_bare_cr(body);
    frame[0] = (frame[0] & 3) | FRAME_METADATA | if bare_cr { FRAME_BARE_CR } else { 0 };
}

fn portable_scan(bytes: &[u8]) -> bool {
    memchr::memchr_iter(b'\r', bytes).any(|position| bytes.get(position + 1) != Some(&b'\n'))
}

pub fn has_bare_cr(bytes: &[u8]) -> bool {
    // Tiny keyboard echoes avoid dispatch overhead. Long chunks classify 16/32
    // adjacent CR/LF pairs per instruction group, including dense CRLF output.
    if bytes.len() < 64 {
        return portable_scan(bytes);
    }
    // The common plain-text case needs only memchr's optimized byte search.
    let Some(first_cr) = memchr::memchr(b'\r', bytes) else {
        return false;
    };
    let bytes = &bytes[first_cr..];
    if bytes.get(1) != Some(&b'\n') {
        return true;
    }
    static SCAN: std::sync::OnceLock<fn(&[u8]) -> bool> = std::sync::OnceLock::new();
    SCAN.get_or_init(select_scan)(bytes)
}

fn select_scan() -> fn(&[u8]) -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if std::arch::is_x86_feature_detected!("avx2") {
            return |bytes| unsafe { scan_avx2(bytes) };
        }
        if std::arch::is_x86_feature_detected!("sse2") {
            return |bytes| unsafe { scan_sse2(bytes) };
        }
    }
    #[cfg(target_arch = "aarch64")]
    if std::arch::is_aarch64_feature_detected!("neon") {
        return |bytes| unsafe { scan_neon(bytes) };
    }
    portable_scan
}

#[cfg(target_arch = "x86")]
use std::arch::x86::*;
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn scan_avx2(bytes: &[u8]) -> bool {
    let cr = _mm256_set1_epi8(13);
    let lf = _mm256_set1_epi8(10);
    let mut offset = 0;
    // The shifted load also stays in bounds. Unaligned loads support any slice.
    while bytes.len() - offset >= 33 {
        let current = _mm256_loadu_si256(bytes.as_ptr().add(offset).cast());
        let next = _mm256_loadu_si256(bytes.as_ptr().add(offset + 1).cast());
        let cr_mask = _mm256_movemask_epi8(_mm256_cmpeq_epi8(current, cr));
        let lf_mask = _mm256_movemask_epi8(_mm256_cmpeq_epi8(next, lf));
        if cr_mask & !lf_mask != 0 {
            return true;
        }
        offset += 32;
    }
    portable_scan(&bytes[offset..])
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "sse2")]
unsafe fn scan_sse2(bytes: &[u8]) -> bool {
    let cr = _mm_set1_epi8(13);
    let lf = _mm_set1_epi8(10);
    let mut offset = 0;
    while bytes.len() - offset >= 17 {
        let current = _mm_loadu_si128(bytes.as_ptr().add(offset).cast());
        let next = _mm_loadu_si128(bytes.as_ptr().add(offset + 1).cast());
        if _mm_movemask_epi8(_mm_cmpeq_epi8(current, cr))
            & !_mm_movemask_epi8(_mm_cmpeq_epi8(next, lf))
            != 0
        {
            return true;
        }
        offset += 16;
    }
    portable_scan(&bytes[offset..])
}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn scan_neon(bytes: &[u8]) -> bool {
    use std::arch::aarch64::*;
    let cr = vdupq_n_u8(13);
    let lf = vdupq_n_u8(10);
    let mut offset = 0;
    while bytes.len() - offset >= 17 {
        let current = vld1q_u8(bytes.as_ptr().add(offset));
        let next = vld1q_u8(bytes.as_ptr().add(offset + 1));
        if vmaxvq_u8(vandq_u8(
            vceqq_u8(current, cr),
            vmvnq_u8(vceqq_u8(next, lf)),
        )) != 0
        {
            return true;
        }
        offset += 16;
    }
    portable_scan(&bytes[offset..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_never_changes_split_utf8_or_escape_sequences() {
        for body in [
            b"plain".as_slice(),
            b"\r\n",
            b"\r",
            b"\rnext",
            b"\x1b[31m",
            &[0xe4, 0xb8],
        ] {
            let mut frame = new_frame(1, body);
            let pointer = frame.as_ptr();
            annotate_frame(&mut frame);
            assert_eq!(&frame[1..], body);
            assert_eq!(frame.as_ptr(), pointer);
            assert_eq!(frame[0] & 3, 1);
            assert_eq!(
                frame[0] & FRAME_BARE_CR != 0,
                body.iter()
                    .enumerate()
                    .any(|(i, byte)| *byte == b'\r' && body.get(i + 1) != Some(&b'\n'))
            );
        }
    }

    #[test]
    fn vector_scanners_match_reference_at_every_boundary_and_alignment() {
        let mut scans: Vec<fn(&[u8]) -> bool> = vec![has_bare_cr, portable_scan];
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        {
            if std::arch::is_x86_feature_detected!("avx2") {
                scans.push(|bytes| unsafe { scan_avx2(bytes) });
            }
            if std::arch::is_x86_feature_detected!("sse2") {
                scans.push(|bytes| unsafe { scan_sse2(bytes) });
            }
        }
        #[cfg(target_arch = "aarch64")]
        if std::arch::is_aarch64_feature_detected!("neon") {
            scans.push(|bytes| unsafe { scan_neon(bytes) });
        }
        for padding in 0..33 {
            for length in 0..130 {
                let mut storage = vec![b'x'; length + padding];
                let body = &mut storage[padding..];
                for position in 0..length {
                    body[position] = b'\r';
                    for scan in &scans {
                        assert!(scan(body));
                    }
                    if position + 1 < length {
                        body[position + 1] = b'\n';
                        for scan in &scans {
                            assert!(!scan(body));
                        }
                        body[position + 1] = b'x';
                    }
                    body[position] = b'x';
                }
                for scan in &scans {
                    assert!(!scan(body));
                }
            }
        }
        let dense = b"a\r\n\r\n\x1b[31m".repeat(1000);
        for scan in scans {
            assert!(!scan(&dense));
        }
    }
}
