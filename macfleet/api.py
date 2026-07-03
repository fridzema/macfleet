from __future__ import annotations

import base64

from fastapi import FastAPI, HTTPException

from macfleet.connect import Fleet
from macfleet.vm import shortname


def build_app(fleet: Fleet | None = None) -> FastAPI:
    fleet = fleet or Fleet()
    api = FastAPI(title="macfleet")

    @api.get("/vms")
    def list_vms() -> list[dict]:
        out = []
        for v in fleet.tart.list():
            out.append({
                "name": v.name, "state": v.state, "source": v.source,
                "healthy": fleet.status(shortname(v.name)) if v.state == "running" else False,
            })
        return out

    @api.post("/vms/{name}/up")
    def up(name: str) -> dict:
        fleet.up(name)
        return {"ok": True}

    @api.post("/vms/{name}/down")
    def down(name: str) -> dict:
        fleet.down(name)
        return {"ok": True}

    @api.post("/vms/{name}/nuke")
    def nuke(name: str) -> dict:
        fleet.nuke(name)
        return {"ok": True}

    @api.get("/vms/{name}/status")
    def status(name: str) -> dict:
        return {"healthy": fleet.status(name)}

    @api.post("/vms/{name}/screenshot")
    def screenshot(name: str) -> dict:
        try:
            png = fleet.computer(name).screenshot()
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"png_b64": base64.b64encode(png).decode()}

    return api
