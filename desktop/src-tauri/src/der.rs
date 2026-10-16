//! Подпись ECDSA P-256: Windows отдаёт r‖s (по 32 байта), а приложение и TLS ждут DER.

fn int(v: &[u8]) -> Vec<u8> {
    let mut v = v;
    while v.len() > 1 && v[0] == 0 && v[1] & 0x80 == 0 {
        v = &v[1..];
    }
    let mut out = vec![0x02];
    if v[0] & 0x80 != 0 {
        out.push(v.len() as u8 + 1);
        out.push(0);
    } else {
        out.push(v.len() as u8);
    }
    out.extend_from_slice(v);
    out
}

pub fn raw_to_der(raw: &[u8]) -> Vec<u8> {
    let half = raw.len() / 2;
    let (r, s) = (int(&raw[..half]), int(&raw[half..]));
    let mut out = vec![0x30, (r.len() + s.len()) as u8];
    out.extend(r);
    out.extend(s);
    out
}

#[cfg(test)]
mod tests {
    use super::raw_to_der;

    #[test]
    fn der() {
        let mut raw = [0u8; 64];
        raw[0] = 0x80; // старший бит r — нужен ведущий ноль
        raw[63] = 1; // s = 1 — ведущие нули отбрасываются
        let d = raw_to_der(&raw);
        assert_eq!(&d[..4], &[0x30, 33 + 2 + 3, 0x02, 33]);
        assert_eq!(&d[d.len() - 3..], &[0x02, 1, 1]);
    }
}
