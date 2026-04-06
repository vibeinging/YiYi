---
name: feishu
description: "Use this skill when the user wants to interact with Feishu/Lark — manage calendars, send messages, create/edit documents, manage tasks, upload/download files, query contacts, or any Feishu workspace operations via the official lark-cli tool."
metadata:
  {
    "yiyi":
      {
        "emoji": "🐦",
        "requires": {}
      }
  }
---

# Feishu CLI Integration

Interact with Feishu (Lark) workspace via the official `lark-cli` tool. All commands are executed through `execute_shell`.

## Prerequisites

Before using Feishu commands, ensure the CLI is installed and authenticated:

```bash
# Install
npm install -g @larksuite/cli

# Initialize config (set app_id/app_secret)
lark-cli config init

# Authenticate (OAuth login)
lark-cli auth login --recommend
```

If commands fail with auth errors, tell the user to configure credentials in Settings > CLI Tools.

## Command Pattern

All Feishu CLI commands follow this pattern:
```bash
lark-cli <domain> <action> [options]
lark-cli <shortcut>          # + prefix shortcuts
```

**Always use `--format json`** for structured output, and `--dry-run` before destructive operations.

## Calendar (日历)

```bash
# View today's agenda
lark-cli calendar +agenda --format json

# View specific date range
lark-cli calendar +agenda --from 2024-01-01 --to 2024-01-07 --format json

# Create event
lark-cli calendar +create-event --summary "Meeting" --start "2024-01-15T10:00:00" --end "2024-01-15T11:00:00"

# Check free/busy
lark-cli calendar +free-busy --from "2024-01-15T09:00:00" --to "2024-01-15T18:00:00" --format json

# List calendars
lark-cli calendar list --format json
```

## Messenger (消息)

```bash
# Send message to a user
lark-cli message send --receive-id "user_id" --msg-type text --content '{"text":"Hello"}'

# Send message to a group
lark-cli message send --receive-id "chat_id" --receive-id-type chat --msg-type text --content '{"text":"Hello"}'

# List recent messages in a chat
lark-cli message list --chat-id "chat_id" --format json
```

## Docs (文档)

```bash
# Create a new document
lark-cli doc create --title "My Document" --format json

# Get document content
lark-cli doc get --document-id "doc_id" --format json

# Update document
lark-cli doc update --document-id "doc_id" --content '{"body":{"content":[]}}'
```

## Drive (云盘)

```bash
# Upload file
lark-cli drive upload --local-path "/path/to/file.pdf" --parent-node "folder_id"

# Download file
lark-cli drive download --file-token "file_token" --local-path "/path/to/save/"

# List folder contents
lark-cli drive list --folder-token "folder_token" --format json
```

## Tasks (任务)

```bash
# Create task
lark-cli task create --summary "Task title" --format json

# List tasks
lark-cli task list --format json

# Update task
lark-cli task update --task-id "task_id" --summary "Updated title"
```

## Wiki (知识库)

```bash
# List wiki spaces
lark-cli wiki list --format json

# Get wiki node
lark-cli wiki get --token "wiki_token" --format json
```

## Contact (通讯录)

```bash
# Search contacts
lark-cli contact search --query "张三" --format json
```

## Sheets (表格)

```bash
# Get spreadsheet info
lark-cli sheets get --spreadsheet-token "token" --format json

# Read cell values
lark-cli sheets values get --spreadsheet-token "token" --range "A1:D10" --format json
```

## Mail (邮件)

```bash
# List mails
lark-cli mail list --format json

# Send mail
lark-cli mail send --to "user@example.com" --subject "Subject" --content "Body"
```

## Meetings (会议)

```bash
# Create meeting
lark-cli meeting +create --topic "Team Standup" --format json

# List meetings
lark-cli meeting list --format json
```

## Best Practices

1. **Always start with `--format json`** for machine-readable output
2. **Use `--dry-run`** for write operations to preview changes before executing
3. **Use `--page-all`** to paginate through all results automatically
4. **Identity switching**: Add `--as user` to act as the user, `--as bot` to act as the bot
5. **Schema introspection**: Use `lark-cli schema <domain>` to discover available fields
6. **Error handling**: If you get 401/403, the token may have expired — ask the user to re-authenticate via `lark-cli auth login --recommend`
7. **Shortcuts first**: The `+` prefix shortcuts (e.g. `+agenda`) are higher-level and easier to use than raw API commands
