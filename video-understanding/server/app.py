import csv
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from queue import Queue
from threading import Lock, Thread
from time import time_ns
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


PROJECT = Path(__file__).resolve().parent
UPLOADS = PROJECT / "uploads"
LOGGER = logging.getLogger(__name__)
TERMINAL = {"done", "error"}
TIMESTAMP = r"(?:\d+:)?\d{1,3}:[0-5]\d(?:\.\d+)?"
TIME_REFERENCE = re.compile(rf"(?<![\d:])({TIMESTAMP})(?:\s*(?:[-–—~～至到]|－)\s*({TIMESTAMP}))?(?![\d:])")


class QuestionRequest(BaseModel):
    question: str = Field(min_length=1, max_length=300)
    focus: str | None = Field(default=None, max_length=80)


def seconds(timestamp):
    value = 0.0
    for part in timestamp.split(":"):
        value = value * 60 + float(part)
    return value


def focused_segments(segments, question, selection):
    if selection:
        matching = [segment for segment in segments if segment["filename"] == selection]
        if not matching:
            raise HTTPException(422, "找不到选中的时间段。")
        return matching

    match = TIME_REFERENCE.search(question)
    if not match:
        return []
    start = seconds(match[1])
    end = seconds(match[2]) if match[2] else start
    if start > end:
        raise HTTPException(422, "起始时间应早于结束时间。")
    if start == end:
        matching = [segment for segment in segments if segment["start"] <= start < segment["end"]]
    else:
        matching = [segment for segment in segments if segment["start"] < end and start < segment["end"]]
    if not matching:
        raise HTTPException(422, "这个时间范围没有可查看的已分析片段。")
    return matching


class AnalysisQueue:
    def __init__(self):
        self.jobs = Queue()
        self.lock = Lock()
        self.active = set()
        self.process = None
        self.stopping = False
        self.thread = Thread(target=self.run, name="video-analysis", daemon=True)

    def start(self):
        self.thread.start()

    def close(self):
        with self.lock:
            self.stopping = True
        self.stop_worker()
        self.jobs.put(None)
        self.thread.join(timeout=10)

    def stop_worker(self):
        with self.lock:
            process, self.process = self.process, None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def submit(self, folder, job):
        with self.lock:
            self.save(folder, job)
            self.active.add(folder.name)
            self.jobs.put((folder, job, None))

    @staticmethod
    def save(folder, job, name="analysis"):
        draft = folder / f"{name}.tmp"
        draft.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        draft.replace(folder / f"{name}.json")

    def read(self, folder):
        with self.lock:
            job = json.loads((folder / "analysis.json").read_text(encoding="utf-8"))
            if job["status"] not in TERMINAL and folder.name not in self.active:
                self.fail(job, "网站曾经停止，未完成的片段需要重新上传分析。")
            return job

    def submit_question(self, folder, request):
        question = request.question.strip()
        if not question:
            raise HTTPException(422, "请输入你的问题。")
        with self.lock:
            analysis = json.loads((folder / "analysis.json").read_text(encoding="utf-8"))
            segments = [segment for segment in analysis["segments"] if segment.get("description")]
            if analysis["status"] not in TERMINAL or not segments:
                raise HTTPException(409, "请等视频分析结束后再提问。")

            focused = focused_segments(segments, question, request.focus)
            questions = folder / "questions"
            questions.mkdir(exist_ok=True)
            saved = [json.loads(path.read_text(encoding="utf-8")) for path in questions.glob("*.json")]
            active_question = next((item for item in saved if item["question_id"] in self.active), None)
            if active_question:
                if active_question["question"] == question and active_question.get("selection") == request.focus:
                    return active_question.copy()
                raise HTTPException(409, "这段视频还有一个问题正在处理，请稍后再试。")
            recent = sorted((item for item in saved if item["status"] == "done"), key=lambda item: item["created"])[-2:]
            job = {"question_id": uuid4().hex, "question": question, "selection": request.focus,
                   "created": time_ns(), "status": "queued", "answer": None, "citations": [], "error": None}
            self.save(questions, job, job["question_id"])
            self.active.add(job["question_id"])
            context = {"segments": focused or segments,
                       "focus": [segment["filename"] for segment in focused] if len(focused) <= 2 else [],
                       "history": [{"question": item["question"], "answer": item["answer"]} for item in recent]}
            self.jobs.put((folder, job, context))
            return job.copy()

    def read_question(self, folder, question_id):
        with self.lock:
            location = folder / "questions" / f"{question_id}.json"
            job = json.loads(location.read_text(encoding="utf-8"))
            if job["status"] not in TERMINAL and question_id not in self.active:
                job.update(status="error", error="网站曾经停止，请重新发送问题。")
            return job

    @staticmethod
    def fail(job, message):
        job.update(status="error", message=message)
        for segment in job["segments"]:
            if segment["status"] not in TERMINAL:
                segment.update(status="error", error=message)

    def worker(self):
        with self.lock:
            if self.stopping:
                raise RuntimeError("Stopping analysis service")
            if self.process is not None and self.process.poll() is None:
                return self.process
            env = os.environ.copy()
            env.update(PYTHONUTF8="1", PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1",
                       PYTHONNOUSERSITE="1", HF_HUB_OFFLINE="1")
            self.process = subprocess.Popen(
                [sys.executable, str(PROJECT / "qwen_worker.py")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
                env=env, cwd=PROJECT,
            )
            return self.process

    def analyze(self, folder, job):
        process = self.worker()
        by_filename = {segment["filename"]: segment for segment in job["segments"]}
        process.stdin.write(json.dumps({"job_dir": str(folder)}) + "\n")
        process.stdin.flush()
        for line in process.stdout:
            event = json.loads(line)
            kind = event["type"]
            with self.lock:
                job.pop("message", None)
                if kind == "done":
                    if any(segment["status"] not in TERMINAL for segment in job["segments"]):
                        self.fail(job, "模型未返回所有片段的结果。")
                    else:
                        job["status"] = "done"
                elif kind == "error":
                    self.fail(job, event["error"])
                else:
                    segment = by_filename[event["filename"]]
                    if kind == "segment_start":
                        segment["status"] = "running"
                    elif kind == "segment":
                        segment.update(status="done", description=event["description"])
                    elif kind == "segment_error":
                        segment.update(status="error", error=event["error"])
                self.save(folder, job)
            if kind in TERMINAL:
                return
        raise RuntimeError(f"Qwen worker exited ({process.poll()})")

    def answer(self, folder, job, context):
        process = self.worker()
        payload = {"action": "question", "job_dir": str(folder), "question": job["question"], **context}
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()
        event = json.loads(process.stdout.readline())
        with self.lock:
            if event["type"] == "answer":
                cited = set(event["citations"])
                citations = [
                    {key: segment[key] for key in ("filename", "start", "end")}
                    for segment in context["segments"] if segment["filename"] in cited
                ]
                job.update(status="done", answer=event["answer"], citations=citations)
            elif event["type"] == "error":
                job.update(status="error", error=event["error"])
            else:
                raise RuntimeError(f"Unexpected question response: {event['type']}")
            self.save(folder / "questions", job, job["question_id"])

    def run(self):
        while (item := self.jobs.get()) is not None:
            folder, job, context = item
            task_name = folder.name if context is None else job["question_id"]
            state_folder, state_name = (folder, "analysis") if context is None else (folder / "questions", task_name)
            with self.lock:
                if self.stopping:
                    return
            try:
                with self.lock:
                    job["status"] = "running"
                    if context is None:
                        job["message"] = "正在准备本地模型。"
                    self.save(state_folder, job, state_name)
                if context is None:
                    self.analyze(folder, job)
                else:
                    self.answer(folder, job, context)
            except Exception:
                LOGGER.exception("Analysis worker failed for %s", folder.name)
                self.stop_worker()
                with self.lock:
                    if context is None:
                        self.fail(job, "Qwen 分析中断，请查看启动终端后重试。")
                    else:
                        job.update(status="error", error="Qwen 回答中断，请稍后重试。")
                    try:
                        self.save(state_folder, job, state_name)
                    except OSError:
                        LOGGER.exception("Could not save analysis failure")
            finally:
                with self.lock:
                    self.active.discard(task_name)


@asynccontextmanager
async def lifespan(app):
    app.state.analysis = AnalysisQueue()
    app.state.analysis.start()
    try:
        yield
    finally:
        app.state.analysis.close()


app = FastAPI(lifespan=lifespan)


@app.get("/")
def home():
    return FileResponse(PROJECT / "index.html")


def split_video(source, clips, ffmpeg):
    clips.mkdir()
    subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(source),
            "-map", "0:v:0", "-an", "-vf", "fps=2,scale='min(640,iw)':-2",
            "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", "-bf", "0",
            "-force_key_frames", "expr:gte(t,n_forced*20)",
            "-f", "segment", "-segment_time", "20", "-reset_timestamps", "1",
            "-segment_list", "segments.csv", "-segment_list_type", "csv", "clip-%03d.mp4",
        ],
        cwd=clips, check=True, capture_output=True, timeout=600,
    )
    with (clips / "segments.csv").open(newline="", encoding="utf-8") as manifest:
        return [
            {"filename": name, "start": float(start), "end": float(end)}
            for name, start, end in csv.reader(manifest)
        ]


@app.post("/upload")
def upload(file: UploadFile):
    if Path(file.filename or "").suffix.lower() != ".mp4":
        raise HTTPException(400, "请选择 MP4 视频。")
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise HTTPException(500, "找不到 FFmpeg，请在启动网站的终端运行 ffmpeg -version 检查。")

    upload_id = uuid4().hex
    folder = UPLOADS / upload_id
    source = folder / "original.mp4"
    completed = False
    try:
        folder.mkdir(parents=True)
        with source.open("wb") as target:
            shutil.copyfileobj(file.file, target, length=1024 * 1024)
        segments = split_video(source, folder / "clips", ffmpeg)
        if not segments or any(segment["end"] <= segment["start"] for segment in segments):
            raise HTTPException(400, "视频太短或没有可用的视频画面。")
        for segment in segments:
            segment.update(status="queued", description=None, error=None)
        job = {"upload_id": upload_id, "status": "queued", "segments": segments}
        result = {**job, "segments": [segment.copy() for segment in segments]}
        app.state.analysis.submit(folder, job)
        completed = True
    except subprocess.CalledProcessError as error:
        LOGGER.warning("FFmpeg failed: %s", error.stderr.decode(errors="replace"))
        raise HTTPException(422, "FFmpeg 无法切分这个视频，请检查文件能否正常播放。") from error
    except subprocess.TimeoutExpired as error:
        raise HTTPException(504, "切分超过 10 分钟，请先用较短的视频测试。") from error
    except OSError as error:
        LOGGER.exception("Could not save or split upload")
        raise HTTPException(500, "保存或切分视频失败，请查看终端日志。") from error
    finally:
        if not completed:
            shutil.rmtree(folder, ignore_errors=True)

    return result


@app.get("/analysis/{upload_id}")
def analysis_status(upload_id: str):
    try:
        return app.state.analysis.read(UPLOADS / validate_id(upload_id))
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "找不到这个视频的分析任务。") from None


def validate_id(value):
    if UUID(value).hex != value:
        raise ValueError("Invalid identifier")
    return value


@app.get("/analysis/{upload_id}/video")
def original_video(upload_id: str):
    try:
        source = UPLOADS / validate_id(upload_id) / "original.mp4"
        if not source.is_file():
            raise FileNotFoundError
        return FileResponse(source, media_type="video/mp4")
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "找不到原视频。") from None


@app.post("/analysis/{upload_id}/questions", status_code=202)
def ask_question(upload_id: str, request: QuestionRequest):
    try:
        return app.state.analysis.submit_question(UPLOADS / validate_id(upload_id), request)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "找不到这个视频的分析任务。") from None


@app.get("/analysis/{upload_id}/questions/{question_id}")
def question_status(upload_id: str, question_id: str):
    try:
        return app.state.analysis.read_question(UPLOADS / validate_id(upload_id), validate_id(question_id))
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "找不到这个问题。") from None
