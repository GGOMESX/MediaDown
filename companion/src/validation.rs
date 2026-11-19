use std::path::{Component, Path, PathBuf};
use url::Url;

const MAX_STEM_CHARS: usize = 120;
const MAX_HEADER_CHARS: usize = 2048;
const FALLBACK_STEM: &str = "video";

#[derive(Debug, PartialEq, Eq)]
pub enum ValidationError {
    InvalidUrl,
    InvalidHeader,
    InvalidJobId,
}

pub fn validate_url(raw: &str) -> Result<Url, ValidationError> {
    let url = Url::parse(raw).map_err(|_| ValidationError::InvalidUrl)?;
    match url.scheme() {
        "http" | "https" if url.host().is_some() => Ok(url),
        _ => Err(ValidationError::InvalidUrl),
    }
}

/// Header values end up as yt-dlp arguments; CR/LF would allow injecting extra HTTP headers.
pub fn validate_header_value(raw: &str) -> Result<String, ValidationError> {
    if raw.len() > MAX_HEADER_CHARS || raw.chars().any(char::is_control) {
        return Err(ValidationError::InvalidHeader);
    }
    Ok(raw.to_owned())
}

pub fn validate_job_id(raw: &str) -> Result<String, ValidationError> {
    let valid = !raw.is_empty() && raw.len() <= 64 && raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid { Ok(raw.to_owned()) } else { Err(ValidationError::InvalidJobId) }
}

/// File name without extension; yt-dlp appends the real extension after merging/conversion.
pub fn sanitize_stem(raw: &str) -> String {
    let cleaned = clean_segment(raw);
    let truncated: String = cleaned.chars().take(MAX_STEM_CHARS).collect();
    let trimmed = trim_edges(&truncated);
    if trimmed.is_empty() { FALLBACK_STEM.to_owned() } else { escape_reserved(trimmed) }
}

/// Relative folder under the Downloads directory; traversal and absolute paths are dropped.
pub fn sanitize_folder(raw: &str) -> PathBuf {
    raw.split(['/', '\\'])
        .filter(|segment| *segment != "." && *segment != "..")
        .map(|segment| trim_edges(&clean_segment(segment)).to_owned())
        .filter(|segment| !segment.is_empty())
        .map(|segment| escape_reserved(&segment))
        .collect()
}

pub fn resolve_output_dir(downloads_dir: &Path, folder: &str) -> PathBuf {
    let relative = sanitize_folder(folder);
    debug_assert!(relative.components().all(|c| matches!(c, Component::Normal(_))));
    downloads_dir.join(relative)
}

/// yt-dlp treats `%` in the output template as a field reference (e.g. `%(id)s`).
pub fn escape_output_template(stem: &str) -> String {
    stem.replace('%', "%%")
}

fn clean_segment(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect()
}

fn trim_edges(raw: &str) -> &str {
    raw.trim_matches(|c: char| c.is_whitespace() || c == '.')
}

fn escape_reserved(segment: &str) -> String {
    let base = segment.split('.').next().unwrap_or_default().to_ascii_lowercase();
    let reserved = matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        || (base.len() == 4 && (base.starts_with("com") || base.starts_with("lpt")) && base.as_bytes()[3].is_ascii_digit());
    if reserved { format!("_{segment}") } else { segment.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_urls() {
        assert!(validate_url("https://cdn.example.com/a.m3u8?sig=1").is_ok());
        assert!(validate_url("http://127.0.0.1:8080/a.mp4").is_ok());
    }

    #[test]
    fn rejects_dangerous_urls() {
        for raw in ["file:///C:/Windows/win.ini", "--exec=calc.exe", "javascript:alert(1)", "ftp://x.com/a", "https://"] {
            assert_eq!(validate_url(raw), Err(ValidationError::InvalidUrl), "{raw}");
        }
    }

    #[test]
    fn rejects_header_injection() {
        assert_eq!(validate_header_value("https://a.com/\r\nCookie: x"), Err(ValidationError::InvalidHeader));
        assert_eq!(validate_header_value("Mozilla/5.0 (Windows NT 10.0)").unwrap(), "Mozilla/5.0 (Windows NT 10.0)");
    }

    #[test]
    fn job_ids_are_restricted_to_safe_characters() {
        assert!(validate_job_id("job_123-abc").is_ok());
        assert!(validate_job_id("../x").is_err());
        assert!(validate_job_id("").is_err());
    }

    #[test]
    fn sanitizes_stems_for_windows() {
        assert_eq!(sanitize_stem("Aula 1: Introdução?"), "Aula 1_ Introdução_");
        assert_eq!(sanitize_stem("  ..oculto.. "), "oculto");
        assert_eq!(sanitize_stem("CON"), "_CON");
        assert_eq!(sanitize_stem("com1.final"), "_com1.final");
        assert_eq!(sanitize_stem("computador"), "computador");
        assert_eq!(sanitize_stem("\u{0000}\u{001f}"), "video");
        assert_eq!(sanitize_stem(&"a".repeat(500)).chars().count(), 120);
    }

    #[test]
    fn folders_cannot_escape_downloads() {
        let base = Path::new("/home/u/Downloads");
        assert_eq!(resolve_output_dir(base, "../../Windows/System32"), base.join("Windows").join("System32"));
        assert_eq!(resolve_output_dir(base, "C:\\Users\\x"), base.join("C_").join("Users").join("x"));
        assert_eq!(resolve_output_dir(base, ""), base.to_path_buf());
        assert_eq!(resolve_output_dir(base, "Cursos/Rust: avançado"), base.join("Cursos").join("Rust_ avançado"));
    }

    #[test]
    fn escapes_template_fields_in_names() {
        assert_eq!(escape_output_template("100% %(id)s"), "100%% %%(id)s");
    }
}
