/// Web search tool — scrapes search-engine HTML, no third-party API key required.
///
/// V4 build: DeepSeek's API has no native web_search tool, so we drive search
/// from the client. Primary engine is DuckDuckGo (no captcha for typical
/// volume); when DDG fails (rate-limit / 5xx / empty page) we fall back to
/// Bing HTML. Both paths return the same `Vec<Hit>` shape.

pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "web_search",
            "Search the web (DuckDuckGo, with Bing fallback). Returns top results with title, snippet, and URL. \
             Use for quick information lookup. Optional `fetch_top_n` inlines the rendered text of the top N \
             pages so the agent gets full content in one call instead of having to follow up with browser_fetch.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query." },
                    "limit": {
                        "type": "integer",
                        "description": "How many results to return (1-15, default 8).",
                        "minimum": 1,
                        "maximum": 15
                    },
                    "fetch_top_n": {
                        "type": "integer",
                        "description": "If >0, fetch the rendered text of the top N result pages and inline them in the output (max 3). Saves a follow-up browser_fetch call.",
                        "minimum": 0,
                        "maximum": 3
                    }
                },
                "required": ["query"]
            }),
        ),
    ]
}

#[derive(Clone, Debug)]
struct Hit {
    title: String,
    url: String,
    snippet: String,
}

fn web_client() -> &'static reqwest::Client {
    static C: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .user_agent(super::BROWSER_UA)
            .build()
            .unwrap_or_default()
    });
    &C
}

async fn search_duckduckgo(query: &str, limit: usize) -> Result<Vec<Hit>, String> {
    static RESULT_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse(".result").unwrap());
    static TITLE_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse(".result__a").unwrap());
    static SNIPPET_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse(".result__snippet").unwrap());

    let resp = web_client()
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query)])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("ddg request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ddg http {}", resp.status()));
    }
    let html = resp.text().await.map_err(|e| format!("ddg body: {e}"))?;
    let doc = scraper::Html::parse_document(&html);

    let mut hits = Vec::new();
    for el in doc.select(&RESULT_SEL) {
        if hits.len() >= limit {
            break;
        }
        let title_el = match el.select(&TITLE_SEL).next() {
            Some(a) => a,
            None => continue,
        };
        let title = title_el.text().collect::<String>();
        if title.trim().is_empty() {
            continue;
        }
        let href = title_el.value().attr("href").unwrap_or("");
        // DDG wraps URLs through a redirect: /l/?uddg=<urlencoded>&...
        let url = if let Some(pos) = href.find("uddg=") {
            let encoded = &href[pos + 5..];
            let end = encoded.find('&').unwrap_or(encoded.len());
            urlencoding::decode(&encoded[..end])
                .unwrap_or_else(|_| encoded[..end].into())
                .into_owned()
        } else {
            href.to_string()
        };
        let snippet = el
            .select(&SNIPPET_SEL)
            .next()
            .map(|s| s.text().collect::<String>())
            .unwrap_or_default();

        hits.push(Hit {
            title: title.trim().to_string(),
            url,
            snippet: snippet.trim().to_string(),
        });
    }
    Ok(hits)
}

async fn search_bing(query: &str, limit: usize) -> Result<Vec<Hit>, String> {
    static RESULT_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse("li.b_algo").unwrap());
    static TITLE_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse("h2 a").unwrap());
    static SNIPPET_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse(".b_caption p, .b_lineclamp2, .b_lineclamp3").unwrap());

    let resp = web_client()
        .get("https://www.bing.com/search")
        .query(&[("q", query)])
        .header("Accept-Language", "en-US,en;q=0.9")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("bing request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("bing http {}", resp.status()));
    }
    let html = resp.text().await.map_err(|e| format!("bing body: {e}"))?;
    let doc = scraper::Html::parse_document(&html);

    let mut hits = Vec::new();
    for el in doc.select(&RESULT_SEL) {
        if hits.len() >= limit {
            break;
        }
        let title_el = match el.select(&TITLE_SEL).next() {
            Some(a) => a,
            None => continue,
        };
        let title = title_el.text().collect::<String>();
        let href = title_el.value().attr("href").unwrap_or("").to_string();
        if title.trim().is_empty() || href.is_empty() {
            continue;
        }
        let snippet = el
            .select(&SNIPPET_SEL)
            .next()
            .map(|s| s.text().collect::<String>())
            .unwrap_or_default();
        hits.push(Hit {
            title: title.trim().to_string(),
            url: href,
            snippet: snippet.trim().to_string(),
        });
    }
    Ok(hits)
}

const FETCHED_PAGE_MAX_CHARS: usize = 3000;

async fn fetch_inline(url: &str) -> Option<String> {
    // Reuse cheap_browser::browser_fetch_tool — same headless-Chrome path the
    // agent itself would call. Bound the inlined text per page to keep the
    // tool result small (and tokens cheap on Pro).
    let raw = super::cheap_browser::browser_fetch_tool(&serde_json::json!({
        "url": url,
        "wait_ms": 2500,
    }))
    .await;
    if raw.starts_with("Error:") {
        return None;
    }
    // Strip the most obvious HTML tags so the snippet is usable. Real
    // structure-aware extraction (readability) is out of scope here — the
    // agent can still call browser_fetch with a higher wait_ms if needed.
    let stripped = strip_html(&raw);
    let trimmed: String = stripped.chars().take(FETCHED_PAGE_MAX_CHARS).collect();
    if trimmed.trim().is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Crude HTML → text. Keeps line breaks; collapses whitespace runs.
fn strip_html(html: &str) -> String {
    let frag = scraper::Html::parse_document(html);
    // Drop script/style nodes by selecting body text only.
    let body_sel = scraper::Selector::parse("body").unwrap();
    let body_text = frag
        .select(&body_sel)
        .next()
        .map(|n| n.text().collect::<Vec<_>>().join(" "))
        .unwrap_or_else(|| {
            // Fall back to whole-doc text if no <body>.
            frag.root_element().text().collect::<Vec<_>>().join(" ")
        });
    // Collapse whitespace
    let mut out = String::with_capacity(body_text.len());
    let mut prev_ws = false;
    for ch in body_text.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}

pub(super) async fn web_search_tool(args: &serde_json::Value) -> String {
    let query = args["query"].as_str().unwrap_or("").trim();
    if query.is_empty() {
        return "Error: query is required".into();
    }
    let limit = args["limit"].as_u64().unwrap_or(8).clamp(1, 15) as usize;
    let fetch_top_n = args["fetch_top_n"].as_u64().unwrap_or(0).min(3) as usize;

    // Try DDG; if it fails or returns nothing usable, fall back to Bing.
    let (hits, engine_used, fallback_note) = match search_duckduckgo(query, limit).await {
        Ok(h) if !h.is_empty() => (h, "duckduckgo", None),
        Ok(_) => match search_bing(query, limit).await {
            Ok(h2) if !h2.is_empty() => (h2, "bing", Some("ddg returned 0 results")),
            Ok(_) => (Vec::new(), "bing", Some("ddg + bing both returned 0")),
            Err(e2) => (Vec::new(), "bing", Some(Box::leak(format!("ddg empty; bing error: {e2}").into_boxed_str()) as &str)),
        },
        Err(e1) => match search_bing(query, limit).await {
            Ok(h2) if !h2.is_empty() => {
                let note = Box::leak(format!("ddg failed ({e1}), used bing").into_boxed_str()) as &str;
                (h2, "bing", Some(note))
            }
            Ok(_) => (Vec::new(), "bing", Some("ddg failed and bing returned 0")),
            Err(e2) => (
                Vec::new(),
                "bing",
                Some(Box::leak(format!("ddg: {e1}; bing: {e2}").into_boxed_str()) as &str),
            ),
        },
    };

    if hits.is_empty() {
        let note = fallback_note.unwrap_or("unknown");
        return format!("No results found for: {query} ({note})");
    }

    // Optionally fetch top N pages inline.
    let mut inlined: Vec<(String, Option<String>)> = Vec::new();
    if fetch_top_n > 0 {
        for hit in hits.iter().take(fetch_top_n) {
            let body = fetch_inline(&hit.url).await;
            inlined.push((hit.url.clone(), body));
        }
    }

    let mut out = String::new();
    if let Some(note) = fallback_note {
        out.push_str(&format!("(engine: {engine_used}; {note})\n\n"));
    } else if engine_used != "duckduckgo" {
        out.push_str(&format!("(engine: {engine_used})\n\n"));
    }
    for (i, hit) in hits.iter().enumerate() {
        out.push_str(&format!(
            "{n}. {title}\n   {snippet}\n   URL: {url}\n",
            n = i + 1,
            title = hit.title,
            snippet = hit.snippet,
            url = hit.url,
        ));
        if let Some((u, body_opt)) = inlined.iter().find(|(u, _)| u == &hit.url) {
            match body_opt {
                Some(body) => {
                    out.push_str(&format!(
                        "   --- inlined page ({chars} chars) ---\n   {body}\n",
                        chars = body.chars().count(),
                        body = body,
                    ));
                }
                None => {
                    out.push_str(&format!("   --- inlined fetch failed for {u} ---\n"));
                }
            }
        }
        out.push('\n');
    }

    // Wrap in external-content envelope — search results + fetched pages
    // can contain attacker-authored text (SEO spam, PI attempts).
    super::output_envelope::wrap_external(
        "web_search",
        super::output_envelope::Trust::Low,
        out.trim(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_query_is_rejected() {
        let out = web_search_tool(&serde_json::json!({ "query": "" })).await;
        assert!(out.starts_with("Error: query is required"));
    }

    #[tokio::test]
    async fn whitespace_query_is_rejected() {
        let out = web_search_tool(&serde_json::json!({ "query": "   " })).await;
        assert!(out.starts_with("Error: query is required"));
    }

    #[tokio::test]
    async fn missing_query_is_rejected() {
        let out = web_search_tool(&serde_json::json!({})).await;
        assert!(out.starts_with("Error: query is required"));
    }

    #[test]
    fn definitions_expose_web_search() {
        let defs = definitions();
        assert!(defs.iter().any(|d| d.function.name == "web_search"));
    }

    #[test]
    fn schema_documents_new_params() {
        let defs = definitions();
        let d = defs.iter().find(|d| d.function.name == "web_search").unwrap();
        let params = serde_json::to_value(&d.function.parameters).unwrap();
        let props = &params["properties"];
        assert!(props.get("limit").is_some(), "limit param missing");
        assert!(props.get("fetch_top_n").is_some(), "fetch_top_n param missing");
    }

    #[test]
    fn strip_html_collapses_whitespace_and_drops_tags() {
        let html = "<html><body>  hello   <b>world</b>\n\n   foo</body></html>";
        let out = strip_html(html);
        assert_eq!(out, "hello world foo");
    }
}
