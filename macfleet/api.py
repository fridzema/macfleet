from __future__ import annotations

import base64

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from macfleet.connect import Fleet
from macfleet.vm import shortname


class ClickRequest(BaseModel):
    x: int
    y: int


class TypeRequest(BaseModel):
    text: str


class KeyRequest(BaseModel):
    combo: str


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

    @api.post("/vms/{name}/click")
    def click(name: str, body: ClickRequest) -> dict:
        try:
            fleet.computer(name).click(body.x, body.y)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @api.post("/vms/{name}/type")
    def type_text(name: str, body: TypeRequest) -> dict:
        try:
            fleet.computer(name).type(body.text)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @api.post("/vms/{name}/key")
    def key(name: str, body: KeyRequest) -> dict:
        try:
            fleet.computer(name).key(body.combo)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    return api
