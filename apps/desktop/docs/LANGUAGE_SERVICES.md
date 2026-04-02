# Desktop Language Services

This document tracks the IDE-oriented diagnostics stack used by the desktop app.

## Goals

- Keep editor and sidebar UI stable while adding language-specific diagnostics.
- Match VS Code behavior as closely as practical for each language.
- Make it easy to add new providers behind the same manager/store/router flow.

## Current Providers

### TypeScript / JavaScript / TSX / JSX

- Backend: `tsserver`
- Reason: VS Code uses `tsserver` for TypeScript and JavaScript language features, so this is the closest path to parity.
- Source:
  - https://github.com/microsoft/TypeScript/wiki/Standalone-Server-%28tsserver%29

### JSON / JSONC

- Backend: `vscode-json-languageservice`
- Reason: This is the JSON language service used in the VS Code ecosystem and supports schema-backed validation.
- Source:
  - https://github.com/microsoft/vscode-json-languageservice

### YAML

- Backend: `yaml-language-server`
- Reason: This is the YAML language server used by the Red Hat YAML extension and supports schema-backed validation through SchemaStore.
- Source:
  - https://github.com/redhat-developer/yaml-language-server

### HTML

- Backend: `vscode-html-language-server` from `vscode-langservers-extracted`
- Reason: The language service package itself does not expose diagnostics, so HTML now uses the bundled VS Code language server path.
- Source:
  - https://www.npmjs.com/package/vscode-langservers-extracted

### CSS / SCSS / LESS

- Backend: `vscode-css-languageservice`
- Reason: This is the CSS language service used in the VS Code ecosystem.
- Source:
  - https://github.com/microsoft/vscode-css-languageservice

### TOML

- Backend: `@taplo/lib`
- Reason: Taplo is the de facto TOML toolkit with a maintained JavaScript/WASM entrypoint suitable for desktop embedding.
- Source:
  - https://taplo.tamasfe.dev/lib/javascript/lib.html

### Dart / Flutter

- Backend: Dart language server via `dart language-server`
- Reason: This matches the official Dart analysis server/LSP flow and works for both Dart and Flutter projects.
- Sources:
  - https://dart.dev/tools/analysis-server
  - https://raw.githubusercontent.com/dart-lang/sdk/main/pkg/analysis_server/tool/lsp_spec/README.md

### Python

- Backend: `pyright-langserver`
- Reason: Pyright is the TypeScript-based Python language server behind the Pyright ecosystem and is close to the VS Code extension path.
- Source:
  - https://github.com/microsoft/pyright

### Go

- Backend: `gopls`
- Reason: `gopls` is the official Go language server maintained by the Go team.
- Source:
  - https://go.dev/gopls/

### Rust

- Backend: `rust-analyzer`
- Reason: `rust-analyzer` is the standard Rust language server used by most editors, including VS Code setups.
- Source:
  - https://rust-analyzer.github.io/book/

### Dockerfile

- Backend: `dockerfile-language-server-nodejs`
- Reason: This is the Dockerfile language server used by the VS Code Docker tooling ecosystem.
- Source:
  - https://github.com/rcjsuen/dockerfile-language-server-nodejs

### GraphQL

- Backend: `graphql-language-service-cli`
- Reason: This provides the `graphql-lsp` server from the GraphiQL language-service stack.
- Source:
  - https://github.com/graphql/graphiql/tree/main/packages/graphql-language-service-cli

## Architecture

- `main/lib/language-services/manager.ts`
  - Registers providers
  - Tracks provider enable/disable state
  - Produces workspace snapshots for the Problems view
- `main/lib/language-services/diagnostics-store.ts`
  - Holds normalized diagnostics per provider/file/workspace
- `main/lib/language-services/lsp/StdioJsonRpcClient.ts`
  - Shared stdio JSON-RPC transport for LSP-based providers
- `main/lib/language-services/lsp/ExternalLspLanguageProvider.ts`
  - Shared LSP provider implementation for stdio-based language servers
- `renderer/providers/LanguageServicesProvider`
  - Syncs open editor documents to enabled providers
- `renderer/routes/_authenticated/settings/behavior/components/DiagnosticsSettings`
  - Lets users toggle providers on or off

## Adding a New Provider

1. Implement `LanguageServiceProvider`.
2. Normalize diagnostics into `LanguageServiceDiagnostic`.
3. Register the provider in `LanguageServiceManager`.
4. Add a renderer-side language mapping in `LanguageServicesProvider`.
5. Add syntax highlighting support if needed in `detect-language.ts` and `loadLanguageSupport.ts`.
6. Extend the settings store/provider ID union if the provider should be user-toggleable.

## Runtime Notes

- TypeScript, Python, YAML, Dockerfile and GraphQL diagnostics are bundled from Node packages and launched with `ELECTRON_RUN_AS_NODE=1`.
- Go diagnostics require `gopls` to be available on the user's PATH.
- Rust diagnostics require `rust-analyzer` to be available on the user's PATH.
