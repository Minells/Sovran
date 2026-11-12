# Native semantic navigation

## Scope

Add three read-only tools to the existing Editor and diagnostics group. The tools are available in Plan and Act when the workspace is trusted.

| Tool                    | Arguments                                              | Result                                                                         |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `list_document_symbols` | Workspace file and optional result limit               | Named symbols with their identifier positions where the provider supplies them |
| `go_to_definition`      | Workspace file, line, column and optional result limit | Definition locations reported by the language provider                         |
| `find_references`       | Workspace file, line, column and optional result limit | Reference locations reported by the language provider                          |

Coordinates are one-based. Columns count UTF-16 code units, as VS Code does internally. Positions are returned as workspace-relative file, line and column so the agent can use them with the next navigation call or with `read_file`. Multi-root paths use the existing `rootName/path` convention. The provider may include the declaration among references.

## Implementation

1. Add an optional semantic navigation capability to `WorkspacePort` and forward it through `CheckpointRecorder`. Implement the VS Code adapter using the document symbol, definition and reference commands. Query the current text document, including unsaved edits to files. Normalize both hierarchical and flat symbols and both definition location shapes.
2. Register the tools in the native context group. Reuse the existing tool settings, per-chat group selection, approvals and dispatch. Validate the query file before calling a provider. Filter returned locations for workspace containment and protected paths, checking both the path supplied by the provider and its canonical target. Report only locations and symbol names.
3. Bound provider wait, candidate scanning, result count and result size. Respect cancellation and revalidate permissions before delivering results. VS Code's command API offers no cancellation token for these calls, so stop waiting and discard late results. Explain empty results and offer `search_files` as a fallback.
4. Add targeted tests for output normalization, path filtering, trust, limits, cancellation and the normal agent pipeline. Verify the built adapter with the TypeScript provider in a temporary VS Code workspace, including a dirty buffer and an unrelated symbol with the same name.
5. Document arguments and limitations in the user guide and architecture. The first increment uses the language providers available in the editor. Workspace-wide symbol indexing and semantic edits are outside its scope.

## Validation

- `npm run check` passed typecheck, lint and 660 tests. The two opt-in managed browser tests were skipped.
- The production build and the VS Code 1.145.2 smoke suite passed on macOS arm64.
- A separate test in a temporary VS Code workspace exercised all three tools through the native registry,
  checkpoint decorator and TypeScript provider. It found the identifier position, followed an import to its
  definition, excluded an unrelated symbol with the same name and found a reference in an unsaved editor buffer.
