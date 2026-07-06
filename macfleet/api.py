from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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
    api.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    @api.exception_handler(RuntimeError)
    async def _runtime_error(_request: Request, exc: RuntimeError) -> JSONResponse:
        # tart/ssh shell-outs raise RuntimeError (e.g. missing golden image, VM not
        # reachable). Return a clean 409 so the response flows back through the CORS
        # middleware with its headers, instead of a bare 500 that drops them.
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @api.get("/vms")
    def list_vms() -> list[dict]:
        vms = fleet.tart.list()
        # Health-check running VMs concurrently — each check is a network round-trip to
        # the guest, so doing them sequentially made /vms scale with fleet size and stall
        # under screenshot load. Parallel keeps the list responsive.
        running = [v for v in vms if v.state == "running"]
        health: dict[str, bool] = {}
        if running:
            with ThreadPoolExecutor(max_workers=min(8, len(running))) as pool:
                health = dict(
                    pool.map(lambda v: (v.name, fleet.status(shortname(v.name))), running)
                )
        return [
            {"name": v.name, "state": v.state, "source": v.source,
             "healthy": health.get(v.name, False)}
            for v in vms
        ]

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

    @api.get("/vms/{name}/logs")
    def logs(name: str, lines: int = 100) -> dict:
        return {"lines": fleet.logs(name, lines)}

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
