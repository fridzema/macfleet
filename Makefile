setup: ; uv sync --extra dev
test: ; uv run pytest -q
lint: ; uv run ruff check .
serve: ; uv run macfleet serve
.PHONY: setup test lint serve
