# Changelog

## Unreleased

### Added
- **Soft restart for `/restart` command**: The daemon now reloads config, agent, and memory in-process while keeping gateway WebSocket connections alive. Falls back to the previous hard restart (fork + kill) if soft restart fails. This prevents Feishu from throttling rapid WebSocket reconnections after restart.
- `Dispatcher.reload()` method for hot-swapping agents and memory without touching gateways.
