---
name: doc_coauthoring
description: "Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content."
metadata:
  {
    "yiyi":
      {
        "emoji": "📝",
        "requires": {}
      }
  }
---

# Doc Co-Authoring Workflow

This skill provides a structured workflow for guiding users through collaborative document creation. Act as an active guide, walking users through three stages: Context Gathering, Refinement & Structure, and Reader Testing.

## When to Offer This Workflow

**Trigger conditions:**
- User mentions writing documentation: "write a doc", "draft a proposal", "create a spec"
- User mentions specific doc types: "PRD", "design doc", "decision doc", "RFC"

## Stage 1: Context Gathering
Close the gap between what the user knows and what Claude knows. Ask about document type, audience, desired impact, template/format, and constraints. Encourage info dumping.

## Stage 2: Refinement & Structure
Build the document section by section through brainstorming, curation, and iterative refinement. For each section: ask clarifying questions, brainstorm options, let user curate, draft, then refine through surgical edits.

## Stage 3: Reader Testing
Test the document with a fresh perspective to catch blind spots. Predict reader questions, test comprehension, and fix any gaps found.

## Final Review
When Reader Testing passes, recommend a final read-through and verify the document achieves the intended impact.
