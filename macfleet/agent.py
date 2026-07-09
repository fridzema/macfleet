from __future__ import annotations

import base64
from typing import Any, Protocol


class Driver(Protocol):
    def next_action(self, screenshot: bytes, task: str) -> dict[str, Any]: ...


def _png_size(png: bytes) -> tuple[int, int]:
    """Width/height from a PNG's IHDR (bytes 16:24). Falls back to 1280x800 for a
    non-PNG/truncated buffer so the computer tool always gets valid dimensions."""
    if len(png) >= 24 and png[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")
    return 1280, 800


def _image_block(png: bytes) -> dict[str, Any]:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                        "data": base64.b64encode(png).decode()}}


def _translate(action_input: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Map a `computer_20251124` tool action to this harness's simplified action dict.
    Returns (action, provides_screenshot): provides_screenshot is True when the toy
    harness (click/type/screenshot only) can honor the action, so the next turn should
    answer with the post-action screenshot; False marks an action the harness can't run,
    which is reported back to the model as a tool error so it picks a supported one."""
    kind = action_input.get("action")
    if kind in ("left_click", "double_click") and action_input.get("coordinate"):
        x, y = action_input["coordinate"]
        return {"action": "click", "x": int(x), "y": int(y)}, True
    if kind == "type" and action_input.get("text") is not None:
        return {"action": "type", "text": action_input["text"]}, True
    if kind == "screenshot":
        return {"action": "screenshot"}, True
    return {"action": str(kind)}, False


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
    """Default driver: Claude computer-use. Requires the [agent] extra + ANTHROPIC_API_KEY.

    Holds the conversation across `next_action` calls and drives Claude's client-side
    `computer_20251124` tool one action per turn: the current screenshot goes up as the
    tool_result for the previous action (or the initial user turn), and Claude's next
    computer action is translated back into this harness's action dict. `run_task` executes
    exactly one action per turn, so only the first tool_use is acted on; any extra tool_use
    blocks in the same turn are answered with a tool error to keep the transcript valid."""

    def __init__(self, model: str = "claude-opus-4-8", client: Any = None) -> None:
        if client is None:
            from anthropic import Anthropic  # lazy import — keeps the [agent] extra optional

            client = Anthropic()
        self._client = client
        self._model = model
        self._messages: list[dict[str, Any]] = []
        # (tool_use_id, provides_screenshot) for the actions Claude asked for last turn.
        self._pending: list[tuple[str, bool]] = []

    def next_action(self, screenshot: bytes, task: str) -> dict[str, Any]:
        width, height = _png_size(screenshot)
        if not self._messages:
            self._messages.append({"role": "user", "content": [
                {"type": "text", "text": task}, _image_block(screenshot)]})
        else:
            # Answer every tool_use from last turn: the acted-on one gets the fresh
            # (post-action) screenshot; the rest get an error so Claude knows only one ran.
            results: list[dict[str, Any]] = []
            for tool_use_id, provides in self._pending:
                if provides:
                    results.append({"type": "tool_result", "tool_use_id": tool_use_id,
                                    "content": [_image_block(screenshot)]})
                else:
                    results.append({"type": "tool_result", "tool_use_id": tool_use_id,
                                    "content": "action not supported by this harness "
                                    "(only left_click, type, screenshot)", "is_error": True})
            self._messages.append({"role": "user", "content": results})
        self._pending = []

        resp = self._client.beta.messages.create(
            model=self._model, max_tokens=4096,
            betas=["computer-use-2025-11-24"],
            tools=[{"type": "computer_20251124", "name": "computer",
                    "display_width_px": width, "display_height_px": height}],
            messages=self._messages,
        )
        self._messages.append({"role": "assistant", "content": resp.content})

        tool_uses = [b for b in resp.content if getattr(b, "type", None) == "tool_use"]
        if not tool_uses:
            return {"action": "done"}
        action, provides = _translate(tool_uses[0].input)
        # First tool_use carries whether it's honored; extras are always reported skipped.
        self._pending = [(tool_uses[0].id, provides)] + [(b.id, False) for b in tool_uses[1:]]
        return action
