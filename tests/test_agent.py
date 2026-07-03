from macfleet.agent import run_task


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
