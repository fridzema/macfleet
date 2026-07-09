import base64

from macfleet.agent import AnthropicDriver, _png_size, _translate, run_task


class FakeComputer:
    def __init__(self):
        self.clicks = []

    def screenshot(self): return b"png"
    def click(self, x, y): self.clicks.append((x, y))
    def type(self, text): pass


class ScriptedDriver:
    def __init__(self, actions): self.actions = list(actions)

    def next_action(self, screenshot, task):
        return self.actions.pop(0)


def test_run_task_applies_clicks_until_done():
    comp = FakeComputer()
    driver = ScriptedDriver([
        {"action": "click", "x": 10, "y": 20},
        {"action": "done"},
    ])
    steps = run_task(comp, "open menu", driver)
    assert steps == 2
    assert comp.clicks == [(10, 20)]


def test_run_task_stops_at_max_steps():
    comp = FakeComputer()
    driver = ScriptedDriver([{"action": "click", "x": 1, "y": 1}] * 100)
    steps = run_task(comp, "spin", driver, max_steps=3)
    assert steps == 3


# --- AnthropicDriver: computer-use translation + conversation threading ---

_PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 8 + (
    (640).to_bytes(4, "big") + (480).to_bytes(4, "big"))


def test_png_size_reads_ihdr_and_falls_back():
    assert _png_size(_PNG) == (640, 480)
    assert _png_size(b"not-a-png") == (1280, 800)  # fallback keeps the tool valid


def test_translate_maps_supported_actions():
    assert _translate({"action": "left_click", "coordinate": [12, 34]}) == (
        {"action": "click", "x": 12, "y": 34}, True)
    assert _translate({"action": "type", "text": "hi"}) == ({"action": "type", "text": "hi"}, True)
    assert _translate({"action": "screenshot"}) == ({"action": "screenshot"}, True)
    # Unsupported by the toy harness -> not honored (reported back as a tool error).
    assert _translate({"action": "scroll"}) == ({"action": "scroll"}, False)


class _Block:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _FakeMessages:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def create(self, **kwargs):
        # Snapshot `messages` — the driver reuses one growing list, so a by-reference
        # record would show every call the final state.
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return _Block(content=self._responses.pop(0))


class _FakeClient:
    def __init__(self, responses):
        self.beta = _Block(messages=_FakeMessages(responses))


def test_anthropic_driver_translates_click_then_done():
    client = _FakeClient([
        [_Block(type="tool_use", id="tu1", input={"action": "left_click", "coordinate": [5, 6]})],
        [_Block(type="text", text="all done")],  # no tool_use -> done
    ])
    driver = AnthropicDriver(client=client)
    assert driver.next_action(_PNG, "open menu") == {"action": "click", "x": 5, "y": 6}
    assert driver.next_action(_PNG, "open menu") == {"action": "done"}

    msgs = client.beta.messages
    # First turn: task text + screenshot. Tool declared at the screenshot's real size.
    assert msgs.calls[0]["tools"][0]["display_width_px"] == 640
    assert msgs.calls[0]["messages"][0]["role"] == "user"
    # Second turn feeds the post-action screenshot back as the tool_result for tu1.
    followup = msgs.calls[1]["messages"][-1]
    assert followup["content"][0]["tool_use_id"] == "tu1"
    assert followup["content"][0]["content"][0]["type"] == "image"


def test_anthropic_driver_reports_extra_tool_uses_as_errors():
    client = _FakeClient([
        [_Block(type="tool_use", id="a", input={"action": "left_click", "coordinate": [1, 2]}),
         _Block(type="tool_use", id="b", input={"action": "type", "text": "x"})],
        [_Block(type="text", text="stop")],
    ])
    driver = AnthropicDriver(client=client)
    assert driver.next_action(_PNG, "go") == {"action": "click", "x": 1, "y": 2}
    driver.next_action(_PNG, "go")
    results = client.beta.messages.calls[1]["messages"][-1]["content"]
    # First tool_use honored with a screenshot; the second reported as an error.
    assert results[0]["tool_use_id"] == "a" and results[0]["content"][0]["type"] == "image"
    assert results[1]["tool_use_id"] == "b" and results[1]["is_error"] is True


def test_anthropic_driver_image_block_is_valid_base64():
    client = _FakeClient([[_Block(type="text", text="done")]])
    driver = AnthropicDriver(client=client)
    driver.next_action(_PNG, "go")
    img = client.beta.messages.calls[0]["messages"][0]["content"][1]
    assert base64.b64decode(img["source"]["data"]) == _PNG
