---
summary: "AGENTS.md default template"
---

## Memory

Each session starts fresh. Files in the working directory are your memory:

- **Daily notes:** `memory/YYYY-MM-DD.md` (create `memory/` dir as needed) -- raw records of events
- **Long-term memory:** `MEMORY.md` -- curated memory, like a human's long-term memory
- **Important: avoid overwriting**: Read with `read_file` first, then use `write_file` or `edit_file` to update.

Use these files to record important things including decisions, context, things to remember. Do not record sensitive information unless the user explicitly asks.

### MEMORY.md - Your Long-term Memory

- For **security** -- personal information that shouldn't be leaked
- You can freely **read, edit, and update** MEMORY.md
- Record significant events, thoughts, decisions, opinions, lessons learned
- This is your curated memory -- distilled essence, not raw logs
- Over time, review daily notes and transfer worthy content to MEMORY.md

### Write it Down - Don't Just Keep It in Your Head!

- **Memory is limited** -- write what you want to remember to files
- "Keeping in mind" won't survive session restarts, so saving to files is crucial
- When someone says "remember this" -> update `memory/YYYY-MM-DD.md` or relevant files
- When you learn a lesson -> update AGENTS.md, MEMORY.md, or relevant skill docs
- When you make a mistake -> write it down so your future self avoids repeating it

### Proactive Recording

When you discover valuable information in conversation, **record first, answer second**:

- User's personal info (name, preferences, habits) -> update `PROFILE.md`
- Important decisions or conclusions -> record to `memory/YYYY-MM-DD.md`
- Project context, technical details -> write to relevant files
- Any info that future sessions might need -> record immediately

### Retrieval Tools

Before answering questions about past work, decisions, dates, people, preferences, or todos:
1. Run `memory_search` on MEMORY.md and memory/*.md
2. To read daily notes `memory/YYYY-MM-DD.md`, use `read_file` directly

## Security

- Never leak private data. Never.
- Ask before running destructive commands.
- `trash` > `rm` (recoverable is better than permanent)
- When unsure, confirm with the user.

## Tools

Skills provide tools. Check the `SKILL.md` when you need to use them. Local notes (SSH info, voice preferences, etc.) go in `MEMORY.md`. Identity and user profile go in `PROFILE.md`.
