"""RVC HTTP API server for dsh-plugin-voice-studio.

Runs inside an RVC (Retrieval-based Voice Conversion WebUI) install and exposes
the conversion and separation over HTTP, so the DSH plugin never needs a
filesystem path to the RVC machine.

    python server/rvc-api.py --port 7866 --rvc-root D:\\path\\to\\RVC

Endpoints
    GET  /health                              -> { ok, rvcRoot, models }
    GET  /models                              -> { models, indexes, rvcRoot }
    POST /convert   (multipart)               -> audio/wav
    POST /separate  (multipart)               -> { vocal, instrumental } base64

Mount args: `--host 0.0.0.0` when DSH runs on another machine, and keep the
machine's firewall in mind.
"""
import argparse
import base64
import io
import os
import sys
import tempfile
import traceback


def parse_args():
    parser = argparse.ArgumentParser(description="RVC HTTP API for dsh-plugin-voice-studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7866)
    parser.add_argument("--rvc-root", default="")
    parser.add_argument("--no-separate", action="store_true", help="disable /separate (PyMSS)")
    args = parser.parse_args()
    # RVC's config module parses sys.argv on import; keep our own flags out of it.
    sys.argv = [sys.argv[0]]
    return args


ARGS = parse_args()
ROOT = os.path.abspath(ARGS.rvc_root or os.getcwd())
if not os.path.isdir(os.path.join(ROOT, "assets", "weights")) and os.path.isdir("assets/weights"):
    ROOT = os.path.abspath(".")

SCRATCH = tempfile.mkdtemp(prefix="rvc-api-")
os.environ["TEMP"] = SCRATCH
os.environ["TMP"] = SCRATCH
os.environ["NUMBA_CACHE_DIR"] = os.path.join(SCRATCH, "numba-cache")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("weight_root", os.path.join("assets", "weights"))
os.environ.setdefault("weight_pymss_root", os.path.join("assets", "pymss_weights"))
os.environ.setdefault("index_root", "logs")
os.environ.setdefault("outside_index_root", os.path.join("assets", "indices"))
os.environ.setdefault("rmvpe_root", os.path.join("assets", "rmvpe"))
os.environ["RVC_CUDA_GRAPH"] = "0"
os.chdir(ROOT)

from fastapi import FastAPI, File, Form, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
import uvicorn  # noqa: E402

app = FastAPI(title="RVC API", version="0.1.0")
_STATE = {"config": None, "vc": None, "vc_model": ""}


def list_models():
    models = []
    weights = os.path.join(ROOT, "assets", "weights")
    if os.path.isdir(weights):
        for name in sorted(os.listdir(weights)):
            if not name.lower().endswith(".pth"):
                continue
            path = os.path.join(weights, name)
            models.append({
                "id": name,
                "name": os.path.splitext(name)[0],
                "kind": "weights",
                "path": path,
                "size": os.path.getsize(path),
            })
    logs = os.path.join(ROOT, "logs")
    if os.path.isdir(logs):
        for experiment in sorted(os.listdir(logs)):
            folder = os.path.join(logs, experiment)
            if not os.path.isdir(folder):
                continue
            files = sorted(n for n in os.listdir(folder) if n.lower().startswith("g_") and n.lower().endswith(".pth"))
            if not files:
                continue
            path = os.path.join(folder, files[-1])
            models.append({
                "id": f"logs/{experiment}/{files[-1]}",
                "name": f"{experiment}/{files[-1][:-4]}",
                "kind": "checkpoint",
                "path": path,
                "size": os.path.getsize(path),
            })
    indexes = []
    for base in (logs, os.path.join(ROOT, "assets", "indices")):
        if not os.path.isdir(base):
            continue
        for folder, _dirs, names in os.walk(base):
            for name in names:
                if name.lower().endswith(".index"):
                    indexes.append({
                        "id": os.path.relpath(os.path.join(folder, name), ROOT).replace("\\", "/"),
                        "name": name,
                        "path": os.path.join(folder, name),
                        "trained": "trained" in name.lower(),
                    })
    return models, indexes


def resolve_model(wanted):
    models, indexes = list_models()
    if not wanted:
        if not models:
            raise RuntimeError("没有可用的 RVC 模型（assets/weights 为空）")
        return models[0], indexes
    if os.path.isabs(wanted) and os.path.isfile(wanted):
        return {"id": os.path.basename(wanted), "path": wanted, "name": os.path.splitext(os.path.basename(wanted))[0]}, indexes
    for model in models:
        if wanted in (model["id"], model["name"], model["path"]):
            return model, indexes
    raise RuntimeError(f"模型不存在：{wanted}")


def auto_index(model, indexes):
    stem = os.path.splitext(os.path.basename(model["path"]))[0].lower()
    candidates = [i for i in indexes if "trained" not in i["name"].lower() and stem in i["name"].lower()]
    preferred = [i for i in candidates if "added" in i["name"].lower()]
    return (preferred or candidates or [{"path": ""}])[0]["path"]


def get_vc(model):
    if _STATE["config"] is None:
        from configs.config import Config

        _STATE["config"] = Config()
    if _STATE["vc"] is None:
        from infer.vc.modules import VC

        _STATE["vc"] = VC(_STATE["config"])
    if _STATE["vc_model"] != model["path"]:
        os.environ["weight_root"] = os.path.dirname(model["path"])
        _STATE["vc"].get_vc(os.path.basename(model["path"]))
        _STATE["vc_model"] = model["path"]
    return _STATE["vc"]


def save_upload(upload: UploadFile) -> str:
    suffix = os.path.splitext(upload.filename or "input.wav")[1] or ".wav"
    path = os.path.join(SCRATCH, f"in-{os.getpid()}-{abs(hash(upload.filename or 'x'))}{suffix}")
    with open(path, "wb") as handle:
        handle.write(upload.file.read())
    return path


@app.get("/health")
def health():
    models, _indexes = list_models()
    return {"ok": True, "rvcRoot": ROOT, "models": len(models), "separate": not ARGS.no_separate}


@app.get("/models")
def models():
    found, indexes = list_models()
    return {"rvcRoot": ROOT, "models": found, "indexes": indexes}


@app.post("/convert")
def convert(
    file: UploadFile = File(...),
    model: str = Form(""),
    index: str = Form(""),
    f0_method: str = Form("rmvpe"),
    f0_up_key: int = Form(0),
    index_rate: float = Form(0.75),
    rms_mix: float = Form(0.25),
    protect: float = Form(0.33),
):
    import numpy as np
    import soundfile as sf

    source = save_upload(file)
    try:
        chosen, indexes = resolve_model(model)
        index_path = index if index and os.path.isfile(index) else auto_index(chosen, indexes)
        vc = get_vc(chosen)
        info, (sample_rate, audio) = vc.vc_single(0, source, f0_up_key, f0_method, index_path, index_rate, 0, rms_mix, protect)
        if audio is None or sample_rate is None:
            raise RuntimeError(str(info))
        audio = np.asarray(audio, dtype=np.float32)
        if audio.size and float(np.abs(audio).max()) > 2.0:
            audio = audio / 32768.0
        if audio.ndim == 1:
            audio = audio[:, None]
        buffer = io.BytesIO()
        sf.write(buffer, audio, int(sample_rate), format="WAV", subtype="FLOAT")
        return Response(content=buffer.getvalue(), media_type="audio/wav")
    except Exception:
        traceback.print_exc()
        return JSONResponse({"error": traceback.format_exc()[-1500:]}, status_code=500)
    finally:
        try:
            os.remove(source)
        except OSError:
            pass


@app.post("/separate")
def separate(file: UploadFile = File(...), model: str = Form("")):
    if ARGS.no_separate:
        return JSONResponse({"error": "/separate 已禁用"}, status_code=404)
    source = save_upload(file)
    try:
        from tools.pymss_webui import PYMSS_MODEL_CHOICES, pymss_separate

        label = model or PYMSS_MODEL_CHOICES[0]
        vocal_dir = os.path.join(SCRATCH, "vocals")
        inst_dir = os.path.join(SCRATCH, "instrumental")
        os.makedirs(vocal_dir, exist_ok=True)
        os.makedirs(inst_dir, exist_ok=True)
        for chunk in pymss_separate(label, os.path.dirname(source), vocal_dir, [os.path.basename(source)], inst_dir, "wav"):
            pass

        def pick(folder, hint):
            files = []
            for folder2, _dirs, names in os.walk(folder):
                for name in names:
                    if name.lower().endswith((".wav", ".flac")):
                        files.append(os.path.join(folder2, name))
            files.sort()
            for path in files:
                if hint in os.path.basename(path).lower():
                    return path
            return files[0] if files else ""

        vocal, instrumental = pick(vocal_dir, "vocal"), pick(inst_dir, "inst")
        if not vocal or not instrumental:
            raise RuntimeError("分离结果不完整")
        return {
            "model": label,
            "vocal": base64.b64encode(open(vocal, "rb").read()).decode("ascii"),
            "instrumental": base64.b64encode(open(instrumental, "rb").read()).decode("ascii"),
        }
    except Exception:
        traceback.print_exc()
        return JSONResponse({"error": traceback.format_exc()[-1500:]}, status_code=500)
    finally:
        try:
            os.remove(source)
        except OSError:
            pass


if __name__ == "__main__":
    print(f"[rvc-api] root={ROOT} listen={ARGS.host}:{ARGS.port}", flush=True)
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="info")
