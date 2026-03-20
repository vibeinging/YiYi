---
name: mcp_builder
description: "Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers."
metadata:
  {
    "yiyi":
      {
        "emoji": "🔌",
        "requires": {}
      }
  }
---

# MCP Server Development Guide

## Overview

Create MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools.

## High-Level Workflow

### Phase 1: Deep Research and Planning
- Study MCP Protocol Documentation: `https://modelcontextprotocol.io/sitemap.xml`
- Recommended stack: TypeScript with Streamable HTTP for remote, stdio for local
- Load framework docs from `reference/` directory

### Phase 2: Implementation
- Set up project structure (see language-specific guides in `reference/`)
- Implement core infrastructure: API client, error handling, response formatting, pagination
- Implement tools with proper input/output schemas and annotations

### Phase 3: Review and Test
- Code quality review (DRY, error handling, type coverage)
- Build and test with MCP Inspector: `npx @modelcontextprotocol/inspector`

### Phase 4: Create Evaluations
- Create 10 complex, realistic evaluation questions
- Output as XML evaluation file

## Reference Files in `reference/` directory:
- `mcp_best_practices.md` - Core guidelines
- `node_mcp_server.md` - TypeScript patterns and examples
- `python_mcp_server.md` - Python patterns and examples
- `evaluation.md` - Evaluation creation guide
