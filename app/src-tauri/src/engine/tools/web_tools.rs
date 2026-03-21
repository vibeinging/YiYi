/// Web search tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "web_search",
            "Search the web using DuckDuckGo. Returns top results with title, snippet and URL. Use for quick information lookup.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" }
                },
                "required": ["query"]
            }),
        ),
    ]
}

pub(super) async fn web_search_tool(args: &serde_json::Value) -> String {
    static WEB_SEARCH_CLIENT: std::sync::LazyLock<reqwest::Client> =
        std::sync::LazyLock::new(|| {
            reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
                .build()
                .unwrap_or_default()
        });
    static RESULT_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse(".result").unwrap());
    static TITLE_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse(".result__a").unwrap());
    static SNIPPET_SEL: std::sync::LazyLock<scraper::Selector> =
        std::sync::LazyLock::new(|| scraper::Selector::parse(".result__snippet").unwrap());

    let query = args["query"].as_str().unwrap_or("").trim();
    if query.is_empty() {
        return "Error: query is required".into();
    }

    let resp = match WEB_SEARCH_CLIENT
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query)])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return format!("Search request failed: {}", e),
    };

    let html = match resp.text().await {
        Ok(t) => t,
        Err(e) => return format!("Failed to read response: {}", e),
    };

    let document = scraper::Html::parse_document(&html);
    let result_sel = &*RESULT_SEL;
    let title_sel = &*TITLE_SEL;
    let snippet_sel = &*SNIPPET_SEL;

    let mut results = Vec::new();
    for el in document.select(&result_sel) {
        if results.len() >= 8 {
            break;
        }
        let title = el
            .select(&title_sel)
            .next()
            .map(|a| a.text().collect::<String>())
            .unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        let href = el
            .select(&title_sel)
            .next()
            .and_then(|a| a.value().attr("href"))
            .unwrap_or("");
        let snippet = el
            .select(&snippet_sel)
            .next()
            .map(|s| s.text().collect::<String>())
            .unwrap_or_default();

        // DuckDuckGo HTML wraps URLs in a redirect; extract the real URL
        let url = if let Some(pos) = href.find("uddg=") {
            let encoded = &href[pos + 5..];
            let end = encoded.find('&').unwrap_or(encoded.len());
            urlencoding::decode(&encoded[..end])
                .unwrap_or_else(|_| encoded[..end].into())
                .into_owned()
        } else {
            href.to_string()
        };

        results.push(format!(
            "{}. {}\n   {}\n   URL: {}",
            results.len() + 1,
            title.trim(),
            snippet.trim(),
            url
        ));
    }

    if results.is_empty() {
        format!("No results found for: {}", query)
    } else {
        results.join("\n\n")
    }
}
