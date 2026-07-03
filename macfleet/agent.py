from __future__ import annotations

from typing import Any, Protocol


class Driver(Protocol):
    def next_action(self, screenshot: bytes, task: str) -> dict[str, Any]: ...


def run_task(computer: Any, task: str, driver: Driver, max_steps: int = 20) -> int:
    for step in range(1, max_steps + 1):
        action = driver.next_action(computer.screenshot(), task)
        kind = action.get("action")
        if kind == "done":
            return step
        if kind == "click":
            computer.click(action["x"], action["y"])
        elif kind == "type":
            computer.type(action["text"])
        if step == max_steps:
            return step
    return max_steps


class AnthropicDriver:
    """Default driver: Claude computer-use. Requires the [agent] extra + ANTHROPIC_API_KEY."""

    def __init__(self, model: str = "claude-opus-4-8") -> None:
        from anthropic import Anthropic  # lazy import

        self._client = Anthropic()
        self._model = model

    def next_action(self, screenshot: bytes, task: str) -> dict[str, Any]:
        # Minimal single-turn computer-use call; expand as needed.
        raise NotImplementedError("wire Anthropic computer-use tool loop here")
