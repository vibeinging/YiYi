/// WeCom (企业微信) Bot — Webhook callback + REST API sending.
///
/// 文档: https://developer.work.weixin.qq.com/document/path/90236
///
/// 协议流程:
/// 1. 用户通过 WeCom 自建应用发消息 → WeCom 推送到 webhook callback
/// 2. 收到消息后通过 REST API 回复（需 access_token）
/// 3. access_token 有效期 7200s，需缓存并提前刷新
///
/// 支持消息类型: text, markdown, textcard
use super::formatter;

const TOKEN_URL: &str = "https://qyapi.weixin.qq.com/cgi-bin/gettoken";
const SEND_URL: &str = "https://qyapi.weixin.qq.com/cgi-bin/message/send";

/// Cached access token with expiry.
struct TokenCache {
    token: String,
    expires_at: std::time::Instant,
}

lazy_static::lazy_static! {
    /// Global token cache keyed by "corpid:corpsecret".
    static ref TOKEN_CACHES: std::sync::RwLock<std::collections::HashMap<String, TokenCache>> =
        std::sync::RwLock::new(std::collections::HashMap::new());
}

/// Get a cached or fresh access_token for the given credentials.
/// Refreshes 5 minutes before expiry.
pub async fn get_access_token(corp_id: &str, corp_secret: &str) -> Result<String, String> {
    let cache_key = format!("{}:{}", corp_id, corp_secret);

    // Check cache
    {
        let caches = TOKEN_CACHES.read().unwrap();
        if let Some(cached) = caches.get(&cache_key) {
            if cached.expires_at > std::time::Instant::now() + std::time::Duration::from_secs(300) {
                return Ok(cached.token.clone());
            }
        }
    }

    // Fetch new token
    let client = super::http_client();
    let url = format!(
        "{}?corpid={}&corpsecret={}",
        TOKEN_URL, corp_id, corp_secret
    );

    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("WeCom token request failed: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("WeCom token parse failed: {}", e))?;

    let errcode = json["errcode"].as_i64().unwrap_or(-1);
    if errcode != 0 {
        let errmsg = json["errmsg"].as_str().unwrap_or("unknown error");
        return Err(format!("WeCom gettoken errcode={}: {}", errcode, errmsg));
    }

    let token = json["access_token"]
        .as_str()
        .ok_or("WeCom: no access_token in response")?
        .to_string();

    let expires_in = json["expires_in"].as_u64().unwrap_or(7200);

    // Cache the token
    {
        let mut caches = TOKEN_CACHES.write().unwrap();
        caches.insert(
            cache_key,
            TokenCache {
                token: token.clone(),
                expires_at: std::time::Instant::now()
                    + std::time::Duration::from_secs(expires_in),
            },
        );
    }

    Ok(token)
}

/// Clear cached token (e.g., on auth error).
pub fn clear_token_cache(corp_id: &str, corp_secret: &str) {
    let cache_key = format!("{}:{}", corp_id, corp_secret);
    let mut caches = TOKEN_CACHES.write().unwrap();
    caches.remove(&cache_key);
}

/// Send a message to a WeCom user via the application message API.
///
/// If the content has markdown formatting, sends as markdown type.
/// Otherwise sends as text. Falls back to text if markdown fails.
pub async fn send_message(
    corp_id: &str,
    corp_secret: &str,
    agent_id: &str,
    to_user: &str,
    content: &str,
) -> Result<(), String> {
    let token = get_access_token(corp_id, corp_secret).await?;
    let client = super::http_client();
    let url = format!("{}?access_token={}", SEND_URL, token);

    let agent_id_num: i64 = agent_id.parse().unwrap_or(0);

    // Determine message type based on content
    let body = if formatter::has_markdown_formatting(content) {
        // WeCom markdown supports: heading, bold, link, quote, font color
        serde_json::json!({
            "touser": to_user,
            "msgtype": "markdown",
            "agentid": agent_id_num,
            "markdown": {
                "content": content,
            },
            "enable_duplicate_check": 1,
            "duplicate_check_interval": 1800,
        })
    } else {
        serde_json::json!({
            "touser": to_user,
            "msgtype": "text",
            "agentid": agent_id_num,
            "text": {
                "content": content,
            },
            "enable_duplicate_check": 1,
            "duplicate_check_interval": 1800,
        })
    };

    let resp = client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("WeCom send failed: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("WeCom send response parse failed: {}", e))?;

    let errcode = json["errcode"].as_i64().unwrap_or(-1);
    match errcode {
        0 => Ok(()),
        // Token expired — clear cache and retry once
        40014 | 42001 | 40001 => {
            log::warn!("WeCom token expired (errcode={}), refreshing...", errcode);
            clear_token_cache(corp_id, corp_secret);
            let new_token = get_access_token(corp_id, corp_secret).await?;
            let retry_url = format!("{}?access_token={}", SEND_URL, new_token);

            // Retry with text type as fallback
            let fallback_body = serde_json::json!({
                "touser": to_user,
                "msgtype": "text",
                "agentid": agent_id_num,
                "text": {
                    "content": formatter::format_wecom(content),
                },
            });

            let retry_resp = client
                .post(&retry_url)
                .json(&fallback_body)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("WeCom retry send failed: {}", e))?;

            let retry_json: serde_json::Value = retry_resp
                .json()
                .await
                .map_err(|e| format!("WeCom retry parse failed: {}", e))?;

            let retry_errcode = retry_json["errcode"].as_i64().unwrap_or(-1);
            if retry_errcode == 0 {
                Ok(())
            } else {
                Err(format!(
                    "WeCom send failed after token refresh: errcode={} {}",
                    retry_errcode,
                    retry_json["errmsg"].as_str().unwrap_or("")
                ))
            }
        }
        _ => {
            let errmsg = json["errmsg"].as_str().unwrap_or("unknown");
            Err(format!("WeCom send errcode={}: {}", errcode, errmsg))
        }
    }
}

/// Test WeCom credentials by requesting an access_token.
pub async fn test_connection(corp_id: &str, corp_secret: &str) -> Result<String, String> {
    let token = get_access_token(corp_id, corp_secret).await?;
    // Token obtained successfully — credentials are valid
    Ok(format!("WeCom credentials verified (token: {}...)", &token[..token.len().min(8)]))
}
