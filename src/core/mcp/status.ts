/** Where an MCP server is in its life. Kept apart from hub.ts so the webview can name it without loading the SDK. */
export type McpStatus = 'disabled' | 'stopped' | 'starting' | 'connected' | 'error';
