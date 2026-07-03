setup: ; uv sync --extra dev
test: ; uv run pytest -q
lint: ; uv run ruff check .
serve: ; uv run macfleet serve
demo: ; uv run pytest tests/test_integration_l0.py -v
.PHONY: setup test lint serve demo
