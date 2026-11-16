import base64
import binascii
import hmac
import os
from threading import Lock

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from app import UPLOADS, app


PASSWORD = os.environ["VIDEO_SHARE_PASSWORD"]
EXPECTED = f"video:{PASSWORD}".encode("ascii")
MAX_REQUEST_BYTES = 80 * 1024 * 1024
MAX_UPLOADS = 20
UPLOAD_LOCK = Lock()


def authenticated(request):
    scheme, _, encoded = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "basic":
        return False
    try:
        credentials = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return False
    return hmac.compare_digest(credentials, EXPECTED)


@app.middleware("http")
async def sharing_limits(request: Request, call_next):
    if not authenticated(request):
        return Response("Sign in to use the video analysis site.", status_code=401,
                        headers={"WWW-Authenticate": 'Basic realm="Video Analysis"'})

    if request.method == "POST" and request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"detail": "请从视频理解网站提交请求。"}, status_code=403)

    if request.method == "POST" and request.url.path == "/upload":
        length = request.headers.get("content-length", "")
        if not length.isdecimal() or len(length) > 10:
            return JSONResponse({"detail": "浏览器未提供上传文件大小。"}, status_code=411)
        if int(length) > MAX_REQUEST_BYTES:
            return JSONResponse({"detail": "试用版请上传小于 80 MB 的视频。"}, status_code=413)
        if not UPLOAD_LOCK.acquire(blocking=False):
            return JSONResponse({"detail": "正在接收另一条视频，请稍后再试。"}, status_code=429)
        try:
            queue = app.state.analysis
            with queue.lock:
                active = bool(queue.active)
            if active:
                return JSONResponse({"detail": "正在分析或回答上一条请求，请稍后再试。"}, status_code=429)
            if UPLOADS.is_dir() and sum(path.is_dir() for path in UPLOADS.iterdir()) >= MAX_UPLOADS:
                return JSONResponse({"detail": "试用版已达到上传数量上限。"}, status_code=429)
            response = await call_next(request)
        finally:
            UPLOAD_LOCK.release()
    else:
        response = await call_next(request)
    response.headers["Cache-Control"] = "private, no-store"
    return response
