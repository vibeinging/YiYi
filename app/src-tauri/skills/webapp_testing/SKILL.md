---
name: webapp_testing
description: "Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs."
metadata:
  {
    "yiyiclaw":
      {
        "emoji": "🧪",
        "requires": {}
      }
  }
---

# Web Application Testing

To test local web applications, write native Python Playwright scripts.

## Helper Scripts
- `scripts/with_server.py` - Manages server lifecycle (supports multiple servers)

Always run scripts with `--help` first.

## Decision Tree

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly, write Playwright script
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Use scripts/with_server.py helper
        └─ Yes → Reconnaissance-then-action pattern
```

## Example: Using with_server.py

```bash
python scripts/with_server.py --server "npm run dev" --port 5173 -- python your_automation.py
```

## Reconnaissance-Then-Action Pattern

1. Navigate and wait for networkidle
2. Take screenshot or inspect DOM
3. Identify selectors from rendered state
4. Execute actions with discovered selectors

## Best Practices

- Use `sync_playwright()` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Always wait for `networkidle` before inspecting dynamic apps
