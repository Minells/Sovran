# Changelog

All notable changes to SOVRAN are documented here. Versions follow `major.minor.patch`; odd minor versions are
pre-releases and even minor versions are stable releases.

## 0.1.0 — Preview

First preview release.

### Agent
- An agent loop with streaming, tool calling, an iteration cap, a loop guard and cancellation.
- Plan mode (read-only by construction) and Act mode (edits and commands with approval).
- Ten built-in tools: read, list, find and search files; workspace and editor context; write, edit and multi-edit files; run terminal commands.
- Edits use exact search/replace with CRLF preservation, a staleness check and undoable `WorkspaceEdit` writes.

### Providers
- Multiple OpenAI-compatible providers and models, with bearer or custom-header auth stored in Secret Storage.
- Automatic fallback to prompted tool calling when a server rejects native tools, remembered per model.
- Tolerant handling of non-streaming responses, `reasoning_content`, `<think>` and `<tool_call>` text.
- Connection test, model discovery, actionable error messages and timeouts.

### Experience
- An Activity Bar view with transcript, inline approvals, native diff review and a command terminal mirror.
- Context chips for the active file or selection and for attached files; native model Quick Pick; status bar item.
- Persistent, searchable chat history with rename and delete.
- Themed through VS Code tokens (dark, light and high contrast), with full keyboard support.

### Security
- Security settings are read from user scope only, and paths are confined to the workspace (symlink-aware).
- Protected paths, a command allow-list that rejects shell metacharacters, and a warning for invisible or bidi characters in commands.
- Strict CSP, markdown rendered with `html:false` plus DOMPurify, and zod-validated webview messages.
