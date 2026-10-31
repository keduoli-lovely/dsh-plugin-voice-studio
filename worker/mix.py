"""Mix the converted vocal back with the instrumental (Voice Studio worker).

Usage: python mix.py <args.json>

Inputs: converted vocal (RVC output, 48 kHz float), instrumental (the separated
stem), and optionally the pre-conversion vocal stem whose loudness we match so
the vocal/instrument balance stays the one the original mix had.
"""
import json
import os
import subprocess
import sys
import traceback
import wave


def read_wav_info(path):
    with wave.open(path, "rb") as handle:
        return handle.getframerate(), handle.getnchannels()


def main():
    args = json.load(open(sys.argv[1], "r", encoding="utf-8"))
    ffmpeg = args.get("ffmpeg") or "ffmpeg"
    temp_dir = args["tempDir"]
    os.makedirs(temp_dir, exist_ok=True)

    import numpy as np
    import soundfile as sf

    synced = os.path.join(temp_dir, "converted_44k.wav")
    sample_rate = int(args.get("sampleRate") or 44100)
    subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", args["converted"],
         "-ar", str(sample_rate), "-ac", "2", "-c:a", "pcm_f32le", synced],
        check=True,
    )

    vocal, _ = sf.read(synced, dtype="float32", always_2d=True)
    inst, inst_sr = sf.read(args["instrumental"], dtype="float32", always_2d=True)
    if inst_sr != sample_rate:
        raise RuntimeError("instrumental sample rate %s does not match %s" % (inst_sr, sample_rate))

    n = min(len(vocal), len(inst))
    vocal, inst = vocal[:n], inst[:n]

    target_rms = None
    if args.get("vocalSource") and os.path.exists(args["vocalSource"]):
        src, _ = sf.read(args["vocalSource"], dtype="float32", always_2d=True)
        m = min(len(src), n)
        if m > 0:
            target_rms = float(np.sqrt(np.mean(src[:m].astype(np.float64) ** 2)))

    vocal_rms = float(np.sqrt(np.mean(vocal.astype(np.float64) ** 2)))
    gain = 1.0
    if target_rms and vocal_rms > 1e-6:
        gain = target_rms / vocal_rms
        vocal = vocal * gain

    mono = vocal.mean(axis=1, keepdims=True)
    mix = inst + mono
    peak = float(np.abs(mix).max())
    if peak > 1e-6:
        mix *= 0.891 / peak

    sf.write(args["outWav"], mix, sample_rate, subtype="PCM_24")

    loudness = args.get("loudness") or "I=-11.5:TP=-1.0:LRA=11"
    mastered = os.path.join(temp_dir, "mastered.wav")
    subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", args["outWav"],
         "-af", "loudnorm=%s" % loudness, "-ar", str(sample_rate), "-ac", "2",
         "-c:a", "pcm_s24le", mastered],
        check=True,
    )
    os.replace(mastered, args["outWav"])

    if args.get("outMp3"):
        subprocess.run(
            [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", args["outWav"],
             "-c:a", "libmp3lame", "-b:a", "320k", args["outMp3"]],
            check=True,
        )

    print(json.dumps({
        "ok": True,
        "sampleRate": sample_rate,
        "durationSec": round(n / float(sample_rate), 3),
        "vocalGain": round(gain, 3),
        "peak": round(float(np.abs(mix).max()), 4),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": traceback.format_exc()[-2000:]}))
        sys.exit(1)
