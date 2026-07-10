from __future__ import annotations

import asyncio
import base64
import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from macfleet.connect import Fleet

logger = logging.getLogger(__name__)


class ClickRequest(BaseModel):
    x: int
    y: int


class TypeRequest(BaseModel):
    text: str


class KeyRequest(BaseModel):
    combo: str


class CreateRequest(BaseModel):
    name: str
    from_snapshot: str | None = None
    ttl: float | None = None
    cpu: int | None = None
    memory: int | None = None
    disk: int | None = None


class LabelRequest(BaseModel):
    label: str


class RestoreRequest(BaseModel):
    snapshot_id: str


class Share(BaseModel):
    tag: str
    host_path: str
    read_only: bool = True


class SharesRequest(BaseModel):
    shares: list[Share]


class RenameRequest(BaseModel):
    new: str


class ResourcesRequest(BaseModel):
    cpu: int | None = None
    memory: int | None = None
    disk_size: int | None = None
    display: str | None = None


class ExecRequest(BaseModel):
    command: str


def build_app(fleet: Fleet | None = None, reap_interval: float = 60.0,
              token: str | None = None) -> FastAPI:
    fleet = fleet or Fleet()

    async def _guard(request: Request) -> None:
        # CSRF/auth: cross-origin form POSTs carry no custom header and CORS does not block
        # them, so the per-run token is required. Enforced on EVERY route, not just mutating
        # ones — GET /vms has a side effect (reap() can delete expired VMs) and reads should
        # not be reachable by an unauthenticated local page/process either. OPTIONS is exempt
        # so CORS preflight still works. Only enforced when a token is configured.
        if request.method == "OPTIONS":
            return
        if not secrets.compare_digest(request.headers.get("x-macfleet-token", ""), token or ""):
            raise HTTPException(status_code=401, detail="invalid or missing API token")

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Backstop: list_vms()/create() reap lazily, but an idle fleet with no API
        # traffic would never sweep expired leases. This interval task covers that gap.
        async def _reap_loop() -> None:
            while True:
                await asyncio.sleep(reap_interval)
                try:
                    await asyncio.to_thread(fleet.reap)
                except Exception:
                    logger.exception("reap backstop failed")

        task = asyncio.create_task(_reap_loop())
        try:
            yield
        finally:
            task.cancel()

    api = FastAPI(title="macfleet", lifespan=lifespan,
                  dependencies=[Depends(_guard)] if token else None)
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:1420", "tauri://localhost", "https://tauri.localhost"],
        allow_methods=["*"], allow_headers=["*"],
    )

    @api.exception_handler(RuntimeError)
    async def _runtime_error(_request: Request, exc: RuntimeError) -> JSONResponse:
        # tart/ssh shell-outs raise RuntimeError (e.g. missing golden image, VM not
        # reachable). Return a clean 409 so the response flows back through the CORS
        # middleware with its headers, instead of a bare 500 that drops them.
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @api.get("/vms")
    def list_vms() -> list[dict]:
        return fleet.list_vms()

    @api.post("/reap")
    def reap() -> dict:
        return {"reaped": fleet.reap()}

    @api.post("/vms")
    def create(body: CreateRequest) -> dict:
        fleet.create(body.name, from_snapshot=body.from_snapshot, ttl=body.ttl,
                     cpu=body.cpu, memory=body.memory, disk=body.disk)
        return {"ok": True}

    @api.get("/host")
    def host() -> dict:
        return fleet.host_info()

    @api.post("/vms/{name}/suspend")
    def suspend(name: str) -> dict:
        fleet.suspend(name)
        return {"ok": True}

    @api.post("/vms/{name}/resume")
    def resume(name: str) -> dict:
        fleet.resume(name)
        return {"ok": True}

    @api.post("/vms/{name}/snapshot")
    def snapshot(name: str, body: LabelRequest) -> dict:
        return {"snapshot_id": fleet.snapshot(name, body.label)}

    @api.get("/snapshots")
    def list_snapshots() -> list[dict]:
        return fleet.snapshots()

    @api.delete("/snapshots/{snapshot_id}")
    def delete_snapshot(snapshot_id: str) -> dict:
        fleet.delete_snapshot(snapshot_id)
        return {"ok": True}

    @api.post("/vms/{name}/rename")
    def rename(name: str, body: RenameRequest) -> dict:
        fleet.rename(name, body.new)
        return {"ok": True}

    @api.post("/vms/{name}/duplicate")
    def duplicate(name: str, body: RenameRequest) -> dict:
        fleet.duplicate(name, body.new)
        return {"ok": True}

    @api.post("/vms/{name}/restore")
    def restore(name: str, body: RestoreRequest) -> dict:
        fleet.restore(name, body.snapshot_id)
        return {"ok": True}

    @api.get("/vms/{name}/shares")
    def get_shares(name: str) -> dict:
        return {"shares": fleet.get_shares(name)}

    @api.put("/vms/{name}/shares")
    def put_shares(name: str, body: SharesRequest) -> dict:
        fleet.set_shares(name, [s.model_dump() for s in body.shares])
        return {"ok": True}

    @api.post("/vms/{name}/restart")
    def restart(name: str) -> dict:
        fleet.restart(name)
        return {"ok": True}

    @api.get("/vms/{name}/resources")
    def get_resources(name: str) -> dict:
        return fleet.resources(name)

    @api.put("/vms/{name}/resources")
    def put_resources(name: str, body: ResourcesRequest) -> dict:
        fleet.set_resources(name, cpu=body.cpu, memory=body.memory,
                            disk_size=body.disk_size, display=body.display)
        return {"ok": True}

    @api.get("/vms/{name}/connection")
    def connection(name: str) -> dict:
        return fleet.connection_info(name)

    @api.post("/vms/{name}/exec")
    def exec_cmd(name: str, body: ExecRequest) -> dict:
        return fleet.exec(name, body.command)

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

    @api.get("/agents/activity")
    def agents_activity(limit: int = 20) -> list[dict]:
        return fleet.activity_recent(limit)

    @api.get("/vms/{name}/metrics")
    def metrics(name: str) -> dict:
        return fleet.metrics(name)

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
