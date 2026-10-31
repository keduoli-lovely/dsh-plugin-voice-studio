"""Built-in vocal/instrumental separation, using the RVC bundle's own PyMSS.

Usage: python pymss_separate.py <args.json>

This is the fallback when MSST_WebUI is not configured: the same models the
RVC WebUI's "伴奏人声分离" tab uses, called directly from its Python package.
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
    temp_dir = args["tempDir"]
    os.makedirs(temp_dir, exist_ok=True)
    vocal_dir = os.path.join(temp_dir, "vocals")
    inst_dir = os.path.join(temp_dir, "instrumental")
    os.makedirs(vocal_dir, exist_ok=True)
    os.makedirs(inst_dir, exist_ok=True)

    os.chdir(rvc_root)
    sys.path.insert(0, rvc_root)
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("weight_root", os.path.join("assets", "weights"))
    os.environ.setdefault("weight_pymss_root", os.path.join("assets", "pymss_weights"))
    os.environ.setdefault("index_root", "logs")
    os.environ.setdefault("outside_index_root", os.path.join("assets", "indices"))
    os.environ.setdefault("rmvpe_root", os.path.join("assets", "rmvpe"))
    os.environ["RVC_CUDA_GRAPH"] = "0"
    os.environ["TEMP"] = temp_dir
    os.environ["TMP"] = temp_dir
    os.environ["NUMBA_CACHE_DIR"] = os.path.join(temp_dir, "numba-cache")

    from tools.pymss_webui import PYMSS_MODEL_CHOICES, pymss_separate

    model_label = args.get("model") or PYMSS_MODEL_CHOICES[0]
    song = os.path.abspath(args["song"])
    generator = pymss_separate(
        model_label,
        os.path.dirname(song),
        vocal_dir,
        [os.path.basename(song)],
        inst_dir,
        "wav",
    )
    last = ""
    for chunk in generator:
        last = str(chunk)

    def pick(folder, hint):
        files = []
        for root, _dirs, names in os.walk(folder):
            for name in names:
                if name.lower().endswith((".wav", ".flac", ".mp3")):
                    files.append(os.path.join(root, name))
        if not files:
            return ""
        files.sort()
        for path in files:
            if hint in os.path.basename(path).lower():
                return path
        return files[0]

    vocal = pick(vocal_dir, "vocal")
    instrumental = pick(inst_dir, "inst")
    print(json.dumps({
        "ok": bool(vocal and instrumental),
        "vocal": vocal,
        "instrumental": instrumental,
        "model": model_label,
        "log": last[-1500:],
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": traceback.format_exc()[-2000:]}))
        sys.exit(1)
