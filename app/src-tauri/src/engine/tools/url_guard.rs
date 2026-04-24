//! URL safety gate for any tool that takes a user- or LLM-supplied URL
//! (browser_use open/goto, web_fetch, future webhooks).
//!
//! Prevents the LLM from being tricked into fetching:
//!   - Cloud metadata endpoints (AWS / GCP / Azure / DigitalOcean IMDS)
//!     → trivial credential exfil on any hosted env
//!   - `localhost` / `127.0.0.1` / `0.0.0.0` → scrape the user's own
//!     dev servers, grafana dashboards, admin UIs
//!   - Private RFC 1918 ranges (10.0.0.0/8, 172.16-31, 192.168.0.0/16)
//!     + carrier-grade NAT 100.64/10 → home LAN pivot (NAS / router /
//!     printer admin panels)
//!   - `file://` → read user files the agent isn't supposed to touch
//!   - Non-http(s) schemes (`javascript:`, `data:`, `ftp:`, `chrome:`)
//!     → browser XSS / auto-download vectors
//!
//! This is NOT a complete SSRF defense (DNS rebinding, TOCTOU, redirect
//! chains all bypass string-level blocks). But it's the cheap first layer
//! Priya flagged as missing (P0-3 configurable guardrail).

use std::net::IpAddr;

/// Outcome of a URL check.
#[derive(Debug, PartialEq, Eq)]
pub enum UrlVerdict {
    Allow,
    Deny(&'static str),
}

/// Check a URL against the deny list. Returns `UrlVerdict::Deny(reason)`
/// if blocked, `UrlVerdict::Allow` otherwise.
///
/// The reason string is a stable machine code suitable to embed in a
/// tool_result — the LLM must not be able to learn a natural-language
/// phrase by retrying.
pub fn check_url(raw: &str) -> UrlVerdict {
    let trimmed = raw.trim();

    // Scheme check — only allow http/https. Catches file://, javascript:,
    // data:, ftp:, chrome-extension:, about:, view-source:, etc.
    let lowered = trimmed.to_ascii_lowercase();
    let scheme_ok = lowered.starts_with("http://") || lowered.starts_with("https://");
    if !scheme_ok {
        return UrlVerdict::Deny("url_scheme_blocked");
    }

    let after_scheme = &trimmed[trimmed.find("://").unwrap() + 3..];

    // Host portion = up to the first '/', '?', '#', or end.
    let host_end = after_scheme
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..host_end];

    // Strip userinfo (user:pass@) if present.
    let host_port = authority.rsplit('@').next().unwrap_or(authority);

    // Strip port.
    // IPv6 literal: [::1]:8080 — keep the bracketed form.
    let host = if host_port.starts_with('[') {
        // IPv6 — find closing bracket
        if let Some(end) = host_port.find(']') {
            &host_port[..=end]
        } else {
            return UrlVerdict::Deny("url_malformed");
        }
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };

    let host_lower = host.to_ascii_lowercase();
    if host_lower.is_empty() {
        return UrlVerdict::Deny("url_malformed");
    }

    // Hostname deny list (case-insensitive).
    if matches!(
        host_lower.as_str(),
        "localhost"
            | "localhost.localdomain"
            | "ip6-localhost"
            | "ip6-loopback"
            | "broadcasthost"
    ) {
        return UrlVerdict::Deny("url_loopback_hostname_blocked");
    }

    // .internal / .local / .home / .lan TLDs — home / mDNS / Kubernetes
    // internal. Overly broad but cheap and covers 95% of intranet pivots.
    if host_lower.ends_with(".internal")
        || host_lower.ends_with(".local")
        || host_lower.ends_with(".localdomain")
        || host_lower.ends_with(".home")
        || host_lower.ends_with(".lan")
    {
        return UrlVerdict::Deny("url_internal_tld_blocked");
    }

    // IP literal check — IPv4 and IPv6.
    let stripped = host_lower
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&host_lower);

    if let Ok(ip) = stripped.parse::<IpAddr>() {
        if let Some(code) = ip_deny_code(&ip) {
            return UrlVerdict::Deny(code);
        }
    }

    UrlVerdict::Allow
}

/// Classify an IP literal against known private / metadata ranges.
/// Returns Some(code) if the address should be blocked.
fn ip_deny_code(ip: &IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, d] = v4.octets();

            // 0.0.0.0/8 (including 0.0.0.0 itself — route to localhost on
            // many OSes, a classic SSRF bypass for crude "is it 127?" checks)
            if a == 0 {
                return Some("url_zero_host_blocked");
            }

            // 127.0.0.0/8 loopback
            if a == 127 {
                return Some("url_loopback_ip_blocked");
            }

            // 169.254.0.0/16 — link-local + AWS/GCP/Azure/DO/Alibaba IMDS
            // (169.254.169.254 is the canonical cloud metadata endpoint)
            if a == 169 && b == 254 {
                return Some("url_metadata_blocked");
            }

            // 10.0.0.0/8 — RFC 1918 private
            if a == 10 {
                return Some("url_private_rfc1918_blocked");
            }

            // 172.16.0.0/12 — RFC 1918 private
            if a == 172 && (16..=31).contains(&b) {
                return Some("url_private_rfc1918_blocked");
            }

            // 192.168.0.0/16 — RFC 1918 private
            if a == 192 && b == 168 {
                return Some("url_private_rfc1918_blocked");
            }

            // 100.64.0.0/10 — CGNAT (RFC 6598)
            if a == 100 && (64..=127).contains(&b) {
                return Some("url_private_cgnat_blocked");
            }

            // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
            if a >= 224 {
                return Some("url_multicast_or_reserved_blocked");
            }

            // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — TEST-NET
            if (a == 192 && b == 0 && c == 2)
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
            {
                return Some("url_testnet_blocked");
            }

            let _ = d;
            None
        }
        IpAddr::V6(v6) => {
            // ::1 loopback, :: unspecified
            if v6.is_loopback() || v6.is_unspecified() {
                return Some("url_loopback_ip_blocked");
            }
            // fe80::/10 link-local (mirrors 169.254 on v6)
            let seg0 = v6.segments()[0];
            if (seg0 & 0xffc0) == 0xfe80 {
                return Some("url_link_local_blocked");
            }
            // fc00::/7 unique local (RFC 4193 — v6 equivalent of 1918)
            if (seg0 & 0xfe00) == 0xfc00 {
                return Some("url_private_v6_blocked");
            }
            // ff00::/8 multicast
            if (seg0 & 0xff00) == 0xff00 {
                return Some("url_multicast_or_reserved_blocked");
            }
            None
        }
    }
}

/// Convenience: produce a uniform tool_result error string suitable to return
/// from a tool that rejected a URL. Keeps wording consistent across tools.
pub fn deny_message(code: &str, url: &str) -> String {
    format!(
        "Error: {} (url={}). This URL points at a local, private, or metadata endpoint and is blocked by YiYi's SSRF guard. If the user genuinely wants to reach a local service, they should use a tool that runs on their own machine (execute_shell / pty_session), not a network-fetching tool.",
        code,
        url.chars().take(200).collect::<String>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied(u: &str) -> bool {
        matches!(check_url(u), UrlVerdict::Deny(_))
    }
    fn allowed(u: &str) -> bool {
        check_url(u) == UrlVerdict::Allow
    }
    fn deny_code(u: &str) -> &'static str {
        match check_url(u) {
            UrlVerdict::Deny(c) => c,
            UrlVerdict::Allow => "ALLOWED",
        }
    }

    #[test]
    fn allows_public_urls() {
        assert!(allowed("https://example.com/"));
        assert!(allowed("http://duckduckgo.com/html/?q=hi"));
        assert!(allowed("https://github.com/"));
        assert!(allowed("https://8.8.8.8/")); // public IP is fine
    }

    #[test]
    fn blocks_localhost_variants() {
        assert_eq!(deny_code("http://localhost/"), "url_loopback_hostname_blocked");
        assert_eq!(deny_code("http://127.0.0.1:8080/"), "url_loopback_ip_blocked");
        assert_eq!(deny_code("http://127.1.2.3/"), "url_loopback_ip_blocked");
        assert_eq!(deny_code("http://[::1]/"), "url_loopback_ip_blocked");
        assert_eq!(deny_code("http://0.0.0.0:3000/"), "url_zero_host_blocked");
    }

    #[test]
    fn blocks_cloud_metadata() {
        assert_eq!(
            deny_code("http://169.254.169.254/latest/meta-data/"),
            "url_metadata_blocked"
        );
        assert_eq!(
            deny_code("http://169.254.169.254/computeMetadata/v1/"),
            "url_metadata_blocked"
        );
    }

    #[test]
    fn blocks_private_ranges() {
        assert_eq!(deny_code("http://10.0.0.1/"), "url_private_rfc1918_blocked");
        assert_eq!(deny_code("http://172.16.5.5/"), "url_private_rfc1918_blocked");
        assert_eq!(deny_code("http://192.168.1.1/"), "url_private_rfc1918_blocked");
        assert_eq!(deny_code("http://100.64.1.1/"), "url_private_cgnat_blocked");
    }

    #[test]
    fn blocks_non_http_schemes() {
        assert_eq!(deny_code("file:///etc/passwd"), "url_scheme_blocked");
        assert_eq!(deny_code("javascript:alert(1)"), "url_scheme_blocked");
        assert_eq!(deny_code("data:text/html,<script>"), "url_scheme_blocked");
        assert_eq!(deny_code("ftp://internal.example/"), "url_scheme_blocked");
        assert_eq!(deny_code("chrome://settings"), "url_scheme_blocked");
    }

    #[test]
    fn blocks_internal_tlds() {
        assert_eq!(
            deny_code("http://printer.lan/"),
            "url_internal_tld_blocked"
        );
        assert_eq!(
            deny_code("https://nas.local/files"),
            "url_internal_tld_blocked"
        );
    }

    #[test]
    fn handles_userinfo_and_port() {
        // user:pass@host is a classic bypass attempt ("I can look like a
        // public host by putting localhost@ in the userinfo"). The RFC
        // says the true host is after '@', so we should see 127.0.0.1.
        assert_eq!(
            deny_code("http://example.com@127.0.0.1/"),
            "url_loopback_ip_blocked"
        );
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(deny_code("HTTP://LOCALHOST/"), "url_loopback_hostname_blocked");
    }

    #[test]
    fn deny_message_format_is_stable() {
        let msg = deny_message("url_loopback_ip_blocked", "http://127.0.0.1/");
        assert!(msg.starts_with("Error: url_loopback_ip_blocked"));
        assert!(msg.contains("url=http://127.0.0.1/"));
    }

    #[test]
    fn rejects_malformed() {
        assert!(denied("https://"));
    }
}
