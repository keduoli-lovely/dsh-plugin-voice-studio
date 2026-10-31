"""Headless RVC conversion worker for dsh-plugin-voice-studio.

Usage: python rvc_convert.py <args.json>
Writes a JSON result to stdout (single line) and the converted vocal to the
requested output path.

Why a worker instead of the RVC WebUI: the WebUI binds a port, a browser and a
GPU process we do not own. Calling the same VC class directly is what the WebUI
does internally, only with an explicit model, index and scratch directory.

The scratch-directory handling is load-bearing: the RVC bundle points TMP at a
folder its own ACL may not allow, and numba then blocks forever while importing
librosa. Everything here points at a writable directory first.
"""
import json
import os
import sys
import traceback


def main():
    args = json.load(open(sys.argv[1], "r", encoding="utf-8"))
    # RVC's config module parses sys.argv when Config() is constructed; keep our
    # own argument out of that argparse so a JSON path never becomes an option.
    sys.argv = [sys.argv[0]]
    rvc_root = args["rvcRoot"]
    temp_dir = args.get("tempDir") or os.path.join(rvc_root, "TEMP")
    os.makedirs(temp_dir, exist_ok=True)

    os.chdir(rvc_root)
    sys.path.insert(0, rvc_root)
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("no_proxy", "localhost, 127.0.0.1, ::1")
    os.environ.setdefault("weight_root", os.path.join("assets", "weights"))
    os.environ.setdefault("weight_pymss_root", os.path.join("assets", "pymss_weights"))
    os.environ.setdefault("index_root", "logs")
    os.environ.setdefault("outside_index_root", os.path.join("assets", "indices"))
    os.environ.setdefault("rmvpe_root", os.path.join("assets", "rmvpe"))
    os.environ["RVC_CUDA_GRAPH"] = "0"
    os.environ["TEMP"] = temp_dir
    os.environ["TMP"] = temp_dir
    os.environ["NUMBA_CACHE_DIR"] = os.path.join(temp_dir, "numba-cache")

    import numpy as np
    import soundfile as sf

    from configs.config import Config
    from infer.vc.modules import VC

    model_path = os.path.abspath(args["model"])
    # get_vc() resolves the model as <weight_root>/<sid>, so aim weight_root at
    # the model's own folder instead of copying checkpoints into assets/weights.
    os.environ["weight_root"] = os.path.dirname(model_path)
    sid = os.path.basename(model_path)

    cfg = Config()
    vc = VC(cfg)
    vc.get_vc(sid)

    index_path = args.get("index") or ""
    info, (sr, audio) = vc.vc_single(
        0,
        args["input"],
        int(args.get("f0UpKey") or 0),
        args.get("f0Method") or "rmvpe",
        index_path,
        float(args.get("indexRate", 0.75)),
        0,
        float(args.get("rmsMix", 0.25)),
        float(args.get("protect", 0.33)),
    )
    if audio is None or sr is None:
        raise RuntimeError("RVC conversion returned no audio: %s" % str(info))

    audio = np.asarray(audio, dtype=np.float32)
    peak = float(np.abs(audio).max()) if audio.size else 0.0
    # The VC class returns int16-scaled floats; normalise so downstream mixing
    # and loudness matching work in the usual -1..1 domain.
    if peak > 2.0:
        audio = audio / 32768.0
        peak = float(np.abs(audio).max())
    if audio.ndim == 1:
        audio = audio[:, None]
    sf.write(args["output"], audio, int(sr), subtype="FLOAT")

    print(json.dumps({
        "ok": True,
        "sampleRate": int(sr),
        "samples": int(audio.shape[0]),
        "durationSec": round(audio.shape[0] / float(sr), 3),
        "peak": round(peak, 4),
        "index": index_path,
        "info": info,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": traceback.format_exc()[-2000:]}))
        sys.exit(1)
