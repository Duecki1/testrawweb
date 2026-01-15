use anyhow::{Context, Result};
use exif::{In, Reader, Tag, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ExtractedMeta {
    pub camera_rating: Option<i32>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub taken_at: Option<String>,
    pub orientation: Option<i32>,
}

pub fn read_metadata(path: &Path) -> Result<ExtractedMeta> {
    let file = fs::File::open(path).with_context(|| format!("open {:?}", path))?;
    let mut bufreader = BufReader::new(&file);

    let exif = Reader::new().read_from_container(&mut bufreader).ok();

    let mut camera_rating = None;
    let mut gps_lat = None;
    let mut gps_lon = None;
    let mut taken_at = None;
    let mut orientation = None;

    if let Some(exif) = exif {
        camera_rating = extract_rating(&exif);
        if let Some(value) = extract_datetime(&exif) {
            taken_at = Some(value);
        }
        if let Some((lat, lon)) = extract_gps(&exif) {
            gps_lat = Some(lat);
            gps_lon = Some(lon);
        }
        orientation = extract_orientation(&exif);
    }

    if camera_rating.is_none() {
        if let Some(xmp_rating) = extract_xmp_rating_from_path(path).ok().flatten() {
            camera_rating = Some(xmp_rating);
        } else if let Some(sidecar_rating) = extract_sidecar_rating(path).ok().flatten() {
            camera_rating = Some(sidecar_rating);
        }
    }

    Ok(ExtractedMeta {
        camera_rating,
        gps_lat,
        gps_lon,
        taken_at,
        orientation,
    })
}

pub fn preview_cache_path(preview_dir: &Path, rel_path: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(rel_path.as_bytes());
    let hash = hasher.finalize();
    let name = format!("{}.jpg", hex::encode(hash));
    preview_dir.join(name)
}

pub fn ensure_preview(path: &Path, preview_path: &Path) -> Result<bool> {
    let source_meta = fs::metadata(path)?;
    let source_modified = source_meta.modified().ok();

    if preview_path.exists() {
        if let (Some(src), Ok(prev_meta)) = (source_modified, fs::metadata(preview_path)) {
            if let Ok(prev_modified) = prev_meta.modified() {
                if prev_modified >= src {
                    return Ok(true);
                }
            }
        }
    }

    let data = fs::read(path).with_context(|| format!("read {:?}", path))?;
    if let Some((start, end)) = find_largest_jpeg(&data) {
        if end > start {
            fs::write(preview_path, &data[start..end])?;
            return Ok(true);
        }
    }

    Ok(false)
}

fn extract_rating(exif: &exif::Exif) -> Option<i32> {
    const TAG_RATING: u16 = 0x4746; // Rating
    const TAG_RATING_PERCENT: u16 = 0x4749; // RatingPercent

    let mut rating = None;
    let mut rating_percent = None;

    for field in exif.fields() {
        match field.tag.number() {
            TAG_RATING => {
                rating = parse_numeric(&field.value);
            }
            TAG_RATING_PERCENT => {
                rating_percent = parse_numeric(&field.value);
            }
            _ => {}
        }
    }

    if let Some(value) = rating {
        return Some(value.clamp(0, 5));
    }

    if let Some(percent) = rating_percent {
        let stars = ((percent as f32) / 20.0).round() as i32;
        return Some(stars.clamp(0, 5));
    }

    None
}

fn parse_numeric(value: &Value) -> Option<i32> {
    match value {
        Value::Byte(v) => v.get(0).map(|n| *n as i32),
        Value::Short(v) => v.get(0).map(|n| *n as i32),
        Value::Long(v) => v.get(0).map(|n| *n as i32),
        Value::SShort(v) => v.get(0).map(|n| *n as i32),
        Value::SLong(v) => v.get(0).map(|n| *n as i32),
        _ => None,
    }
}

fn extract_datetime(exif: &exif::Exif) -> Option<String> {
    let field = exif
        .get_field(Tag::DateTimeOriginal, In::PRIMARY)
        .or_else(|| exif.get_field(Tag::DateTime, In::PRIMARY));

    field.map(|f| f.display_value().with_unit(exif).to_string())
}

fn extract_orientation(exif: &exif::Exif) -> Option<i32> {
    exif
        .get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|field| parse_numeric(&field.value))
        .filter(|value| (1..=8).contains(value))
}

fn extract_gps(exif: &exif::Exif) -> Option<(f64, f64)> {
    let lat = exif.get_field(Tag::GPSLatitude, In::PRIMARY)?;
    let lat_ref = exif.get_field(Tag::GPSLatitudeRef, In::PRIMARY)?;
    let lon = exif.get_field(Tag::GPSLongitude, In::PRIMARY)?;
    let lon_ref = exif.get_field(Tag::GPSLongitudeRef, In::PRIMARY)?;

    let lat_value = gps_value(&lat.value)?;
    let lon_value = gps_value(&lon.value)?;

    let lat_dir = lat_ref.display_value().with_unit(exif).to_string();
    let lon_dir = lon_ref.display_value().with_unit(exif).to_string();

    let mut lat_final = lat_value;
    if lat_dir.trim().starts_with('S') {
        lat_final = -lat_final;
    }

    let mut lon_final = lon_value;
    if lon_dir.trim().starts_with('W') {
        lon_final = -lon_final;
    }

    Some((lat_final, lon_final))
}

fn gps_value(value: &Value) -> Option<f64> {
    match value {
        Value::Rational(v) => {
            if v.len() >= 3 {
                let deg = rational_to_f64(&v[0]);
                let min = rational_to_f64(&v[1]);
                let sec = rational_to_f64(&v[2]);
                Some(deg + (min / 60.0) + (sec / 3600.0))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn rational_to_f64(value: &exif::Rational) -> f64 {
    if value.denom == 0 {
        return 0.0;
    }
    value.num as f64 / value.denom as f64
}

fn extract_xmp_rating_from_path(path: &Path) -> Result<Option<i32>> {
    let data = fs::read(path)?;
    extract_xmp_rating_from_bytes(&data)
}

fn extract_sidecar_rating(path: &Path) -> Result<Option<i32>> {
    let sidecar = path.with_extension("xmp");
    if !sidecar.exists() {
        return Ok(None);
    }
    let data = fs::read(sidecar)?;
    extract_xmp_rating_from_bytes(&data)
}

fn extract_xmp_rating_from_bytes(data: &[u8]) -> Result<Option<i32>> {
    let data_str = String::from_utf8_lossy(data);
    let start = data_str.find("<x:xmpmeta");
    let end = data_str.find("</x:xmpmeta>");

    let (start, end) = match (start, end) {
        (Some(s), Some(e)) if e > s => (s, e + "</x:xmpmeta>".len()),
        _ => return Ok(None),
    };

    let xmp = &data_str[start..end];
    Ok(parse_xmp_rating(xmp))
}

fn parse_xmp_rating(xmp: &str) -> Option<i32> {
    if let Some(index) = xmp.find("xmp:Rating") {
        let tail = &xmp[index + "xmp:Rating".len()..];
        if let Some(eq) = tail.find('=') {
            let after = tail[eq + 1..].trim_start();
            if let Some(quote) = after.chars().next() {
                if quote == '\'' || quote == '"' {
                    if let Some(end_quote) = after[1..].find(quote) {
                        let raw = &after[1..1 + end_quote];
                        if let Ok(val) = raw.trim().parse::<i32>() {
                            return Some(val.clamp(0, 5));
                        }
                    }
                }
            }
        }
    }

    if let Some(open) = xmp.find("<xmp:Rating>") {
        let tail = &xmp[open + "<xmp:Rating>".len()..];
        if let Some(close) = tail.find("</xmp:Rating>") {
            let raw = &tail[..close];
            if let Ok(val) = raw.trim().parse::<i32>() {
                return Some(val.clamp(0, 5));
            }
        }
    }

    None
}

fn find_largest_jpeg(data: &[u8]) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut i = 0;
    while i + 1 < data.len() {
        if data[i] == 0xFF && data[i + 1] == 0xD8 {
            let start = i;
            i += 2;
            while i + 1 < data.len() {
                if data[i] == 0xFF && data[i + 1] == 0xD9 {
                    let end = i + 2;
                    let size = end - start;
                    if best.map(|(s, e)| e - s).unwrap_or(0) < size {
                        best = Some((start, end));
                    }
                    i = end;
                    break;
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    best
}
