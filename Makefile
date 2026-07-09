# macfleet — top-level entry point.
# Engine (Python/uv) targets run here at the repo root; desktop (Tauri/Vue/bun)
# targets delegate to desktop/Makefile so command logic lives in one place.

.DEFAULT_GOAL := help
.PHONY: help \
	dev dev-frontend serve mcp \
	build build-debug \
	test test-engine test-desktop e2e coverage demo \
	lint lint-engine lint-desktop format format-engine format-desktop \
	setup setup-engine setup-desktop clean

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Development:"
	@echo "  dev            Run the desktop app (Tauri window; auto-spawns the engine sidecar)"
	@echo "  dev-frontend   Run the Vite frontend only (browser, :1420)"
	@echo "  serve          Run the engine API only (:8765)"
	@echo "  mcp            Run the stdio MCP server"
	@echo ""
	@echo "Build:"
	@echo "  build          Build the desktop app bundle"
	@echo "  build-debug    Build the desktop app with debug symbols"
	@echo ""
	@echo "Testing:"
	@echo "  test           Run all unit tests (engine pytest + desktop vitest)"
	@echo "  test-engine    Run engine tests (pytest)"
	@echo "  test-desktop   Run desktop unit tests (vitest)"
	@echo "  e2e            Run desktop end-to-end tests (Playwright)"
	@echo "  coverage       Run desktop unit tests with coverage"
	@echo "  demo           Run the L0 integration demo test"
	@echo ""
	@echo "Lint & Format:"
	@echo "  lint           Lint everything (engine ruff + desktop eslint/biome/clippy)"
	@echo "  lint-engine    Lint the engine (ruff)"
	@echo "  lint-desktop   Lint the desktop app"
	@echo "  format         Format everything (engine ruff + desktop biome/cargo)"
	@echo "  format-engine  Format the engine (ruff format)"
	@echo "  format-desktop Format the desktop app"
	@echo ""
	@echo "Setup & Cleanup:"
	@echo "  setup          Install everything (engine venv + desktop deps)"
	@echo "  setup-engine   Sync the engine venv (uv)"
	@echo "  setup-desktop  Install desktop deps (bun, Playwright browsers, hooks)"
	@echo "  clean          Remove desktop build artifacts"
	@echo ""
	@echo "Aggregates need both halves installed; use the -engine/-desktop"
	@echo "variants to run just one."

# Development / run
dev:
	$(MAKE) -C desktop dev

dev-frontend:
	$(MAKE) -C desktop dev-frontend

serve:
	uv run macfleet serve

mcp:
	uv run --extra mcp macfleet-mcp

# Build
build:
	$(MAKE) -C desktop build

build-debug:
	$(MAKE) -C desktop build-debug

# Testing
test: test-engine test-desktop

test-engine:
	uv run --extra mcp pytest -q

test-desktop:
	$(MAKE) -C desktop test-unit

e2e:
	$(MAKE) -C desktop test-e2e

coverage:
	cd desktop && bun run test:unit:coverage

demo:
	uv run pytest tests/test_integration_l0.py -v

# Lint & Format
lint: lint-engine lint-desktop

lint-engine:
	uv run ruff check .

lint-desktop:
	$(MAKE) -C desktop lint

format: format-engine format-desktop

format-engine:
	uv run ruff format .

format-desktop:
	$(MAKE) -C desktop format

# Setup & Cleanup
setup: setup-engine setup-desktop

setup-engine:
	uv sync --extra dev --extra mcp

setup-desktop:
	$(MAKE) -C desktop setup

clean:
	$(MAKE) -C desktop clean
