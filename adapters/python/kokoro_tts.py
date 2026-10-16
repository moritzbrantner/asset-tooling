#!/usr/bin/env python3
"""Offline Kokoro-82M text-to-speech adapter for asset-tooling process-adapter-v1 (asset-tooling#30).

The module imports with the standard library only. torch, kokoro, misaki and spaCy are imported
inside ``probe`` and ``generate``, so the pure seams (``find_out_of_vocabulary``,
``require_in_vocabulary``, ``verify_model_bundle``) run under a bare interpreter.

Grapheme-to-phoneme conversion is misaki's English G2P with no fallback: a word that neither
misaki's dictionaries nor the caller's versioned lexicon resolve fails the run closed. Kokoro's
own pipeline would silently drop it (or call espeak), so it is not used.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys
import tempfile
import zipfile

MODEL_ID = "hexgrad/Kokoro-82M"
MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
SAMPLE_RATE = 24000
CONTEXT_PHONEMES = 510
UNKNOWN_MARKER = "❓"  # misaki's unknown-token marker

WEIGHTS_FILE = "kokoro-v1_0.pth"
PINNED_FILES = {
    WEIGHTS_FILE: "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4",
    "config.json": "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
}
# SHA-256 of every Kokoro v1.0 English voice at MODEL_REVISION (from the acquisition receipt).
PINNED_VOICES = {
    "af_alloy": "6d877149dd8b348fbad12e5845b7e43d975390e9f3b68a811d1d86168bef5aa3",
    "af_aoede": "c03bd1a4c3716c2d8eaa3d50022f62d5c31cfbd6e15933a00b17fefe13841cc4",
    "af_bella": "8cb64e02fcc8de0327a8e13817e49c76c945ecf0052ceac97d3081480e8e48d6",
    "af_heart": "0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff",
    "af_jessica": "cdfdccb8cc975aa34ee6b89642963b0064237675de0e41a30ae64cc958dd4e87",
    "af_kore": "8bfbc512321c3db49dff984ac675fa5ac7eaed5a96cc31104d3a9080e179d69d",
    "af_nicole": "c5561808bcf5250fe8c5f5de32caf2d94f27e57e95befdb098c5c85991d4c5da",
    "af_nova": "e0233676ddc21908c37a1f102f6b88a59e4e5c1bd764983616eb9eda629dbcd2",
    "af_river": "e149459bd9c084416b74756b9bd3418256a8b839088abb07d463730c369dab8f",
    "af_sarah": "49bd364ea3be9eb3e9685e8f9a15448c4883112a7c0ff7ab139fa4088b08cef9",
    "af_sky": "c799548aed06e0cb0d655a85a01b48e7f10484d71663f9a3045a5b9362e8512c",
    "am_adam": "ced7e284aba12472891be1da3ab34db84cc05cc02b5889535796dbf2d8b0cb34",
    "am_echo": "8bcfdc852bc985fb45c396c561e571ffb9183930071f962f1b50df5c97b161e8",
    "am_eric": "ada66f0eefff34ec921b1d7474d7ac8bec00cd863c170f1c534916e9b8212aae",
    "am_fenrir": "98e507eca1db08230ae3b6232d59c10aec9630022d19accac4f5d12fcec3c37a",
    "am_liam": "c82550757ddb31308b97f30040dda8c2d609a9e2de6135848d0a948368138518",
    "am_michael": "9a443b79a4b22489a5b0ab7c651a0bcd1a30bef675c28333f06971abbd47bd37",
    "am_onyx": "e8452be16cd0f6da7b4579eaf7b1e4506e92524882053d86d72b96b9a7fed584",
    "am_puck": "dd1d8973f4ce4b7d8ae407c77a435f485dabc052081b80ea75c4f30b84f36223",
    "am_santa": "7f2f7582fa2b1f160e90aafe6d0b442a685e773608b6667e545d743b073e97a7",
    "bf_alice": "d292651b6af6c0d81705c2580dcb4463fccc0ff7b8d618a471dbb4e45655b3f3",
    "bf_emma": "d0a423deabf4a52b4f49318c51742c54e21bb89bbbe9a12141e7758ddb5da701",
    "bf_isabella": "cdd4c37003805104d1d08fb1e05855c8fb2c68de24ca6e71f264a30aaa59eefd",
    "bf_lily": "6e09c2e481e2d53004d7e5ae7d3a325369e130a6f45c35a6002de75084be9285",
    "bm_daniel": "fc3fce4e9c12ed4dbc8fa9680cfe51ee190a96444ce7c3ad647549a30823fc5d",
    "bm_fable": "d44935f3135257a9064df99f007fc1342ff1aa767552b4a4fa4c3b2e6e59079c",
    "bm_george": "f1bc812213dc59774769e5c80004b13eeb79bd78130b11b2d7f934542dab811b",
    "bm_lewis": "b5204750dcba01029d2ac9cec17aec3b20a6d64073c579d694a23cb40effbd0e",
}
SPACY_MODEL = "en_core_web_sm"
RUNTIME_PACKAGES = (
    "torch",
    "kokoro",
    "misaki",
    "spacy",
    SPACY_MODEL,
    "transformers",
    "numpy",
    "thinc",
    "num2words",
    "huggingface-hub",
)
OFFLINE_VARIABLES = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY")
SENTENCE_END = frozenset("!.?…")
WORD_CHARACTER = re.compile(r"[^\W_]", re.UNICODE)
REQUEST_FIELDS = frozenset(
    {
        "modelBundlePath",
        "modelId",
        "modelRevision",
        "prompt",
        "seed",
        "threads",
        "sampleRate",
        "voice",
        "lexicon",
        "speed",
    }
)


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        fail(f"required Python package {name!r} is not installed")
    raise AssertionError("unreachable")


# ---------------------------------------------------------------------------
# Pure seams (standard library only)
# ---------------------------------------------------------------------------


def is_word_token(text: str) -> bool:
    return bool(WORD_CHARACTER.search(text or ""))


def find_out_of_vocabulary(tokens) -> list[str]:
    """Word tokens (text with a letter or digit) whose phonemes are missing, empty or unknown."""
    seen: set[str] = set()
    unresolved: list[str] = []
    for token in tokens:
        text = token.text
        if not is_word_token(text):
            continue
        phonemes = token.phonemes
        if phonemes is None or phonemes == "" or UNKNOWN_MARKER in phonemes:
            if text not in seen:
                seen.add(text)
                unresolved.append(text)
    return unresolved


def require_in_vocabulary(tokens) -> None:
    unresolved = find_out_of_vocabulary(tokens)
    if unresolved:
        names = ", ".join(repr(text) for text in unresolved)
        fail(
            f"out-of-vocabulary token(s) with no lexicon entry: {names}; "
            "add them to adapterParameters.lexicon (there is no espeak fallback)"
        )


def verify_model_bundle(root: Path, voice: str) -> None:
    """Check the extracted acquisition bundle against the pinned revision."""
    for name, expected in PINNED_FILES.items():
        path = root / name
        if not path.is_file():
            fail(f"Kokoro bundle is missing {name}")
        actual = sha256_file(path)
        if actual != expected:
            fail(f"Kokoro bundle {name} has SHA-256 {actual}; expected {expected} at revision {MODEL_REVISION}")
    expected_voice = PINNED_VOICES.get(voice)
    if expected_voice is None:
        fail(f"voice {voice!r} is not a pinned Kokoro v1.0 English voice")
    voice_path = root / "voices" / f"{voice}.pt"
    if not voice_path.is_file():
        fail(f"Kokoro bundle is missing voices/{voice}.pt")
    actual_voice = sha256_file(voice_path)
    if actual_voice != expected_voice:
        fail(f"Kokoro bundle voices/{voice}.pt has SHA-256 {actual_voice}; expected {expected_voice}")


def extract_bundle_members(bundle_path: Path, voice: str, destination: Path) -> None:
    """Extract only the files synthesis needs from the acquisition model.zip."""
    wanted = {WEIGHTS_FILE, "config.json", f"voices/{voice}.pt"}
    found: set[str] = set()
    with zipfile.ZipFile(bundle_path) as archive:
        for member in archive.infolist():
            name = member.filename
            if name.startswith("/") or ".." in Path(name).parts or "\\" in name:
                fail(f"Kokoro bundle contains unsafe path {name!r}")
            if name not in wanted:
                continue
            if name in found:
                fail(f"Kokoro bundle contains duplicate entry {name!r}")
            file_type = stat.S_IFMT(member.external_attr >> 16)
            if file_type not in (0, stat.S_IFREG):
                fail(f"Kokoro bundle entry {name!r} is not a regular file")
            found.add(name)
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open("wb") as sink:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    sink.write(chunk)
    missing = sorted(wanted - found)
    if missing:
        fail(f"Kokoro bundle is missing {', '.join(missing)}")


def read_request(path: Path) -> dict:
    request = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(request, dict):
        fail("Kokoro request must be a JSON object")
    unknown = sorted(set(request) - REQUEST_FIELDS)
    if unknown:
        fail(f"Kokoro request contains unsupported field(s): {', '.join(unknown)}")
    if request.get("modelId") != MODEL_ID or request.get("modelRevision") != MODEL_REVISION:
        fail(f"Kokoro request must target {MODEL_ID}@{MODEL_REVISION}")
    if request.get("sampleRate") != SAMPLE_RATE:
        fail(f"Kokoro request sampleRate must be {SAMPLE_RATE}")
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        fail("Kokoro request prompt must be a non-empty string")
    seed = request.get("seed")
    if not isinstance(seed, str) or not re.fullmatch(r"0|[1-9][0-9]*", seed) or int(seed) >= 2**64:
        fail("Kokoro request seed must be a decimal integer string below 2**64")
    threads = request.get("threads")
    if not isinstance(threads, int) or isinstance(threads, bool) or threads < 1:
        fail("Kokoro request threads must be a positive integer")
    voice = request.get("voice")
    if voice not in PINNED_VOICES:
        fail(f"Kokoro request voice {voice!r} is not a pinned Kokoro v1.0 English voice")
    speed = request.get("speed")
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not speed > 0:
        fail("Kokoro request speed must be a number greater than 0")
    lexicon = request.get("lexicon")
    if (
        not isinstance(lexicon, dict)
        or set(lexicon) != {"version", "entries"}
        or not isinstance(lexicon["version"], str)
        or not lexicon["version"]
        or not isinstance(lexicon["entries"], dict)
        or not all(isinstance(word, str) and isinstance(phonemes, str) and word and phonemes for word, phonemes in lexicon["entries"].items())
    ):
        fail("Kokoro request lexicon must be { version, entries: { word: phonemes } }")
    return request


def float_to_pcm16(samples) -> bytes:
    """Deterministic float32 [-1, 1] -> little-endian PCM16: clip, scale by 32767, round half to even."""
    import numpy

    values = numpy.asarray(samples, dtype=numpy.float32)
    if values.ndim != 1:
        fail(f"Kokoro produced audio with shape {values.shape}; expected mono samples")
    if not numpy.all(numpy.isfinite(values)):
        fail("Kokoro produced non-finite audio samples")
    scaled = numpy.rint(numpy.clip(values, -1.0, 1.0).astype(numpy.float64) * 32767.0)
    return scaled.astype("<i2").tobytes()


def write_wav(path: Path, pcm: bytes) -> None:
    import wave

    with wave.open(str(path), "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(SAMPLE_RATE)
        sink.writeframes(pcm)


def chunk_tokens(tokens) -> list[str]:
    """Group G2P tokens into phoneme strings within Kokoro's context, splitting at sentence ends."""

    def phonemes_of(group) -> str:
        return "".join(token.phonemes + (" " if token.whitespace else "") for token in group).strip()

    sentences: list[list] = [[]]
    for token in tokens:
        sentences[-1].append(token)
        if token.phonemes and all(character in SENTENCE_END for character in token.phonemes):
            sentences.append([])
    chunks: list[str] = []
    current: list = []
    for sentence in sentences:
        if not sentence:
            continue
        if len(phonemes_of(sentence)) > CONTEXT_PHONEMES:
            text = "".join(token.text + token.whitespace for token in sentence).strip()
            fail(
                f"sentence exceeds Kokoro's {CONTEXT_PHONEMES}-phoneme context and would be truncated; "
                f"split it in the prompt: {text[:80]!r}"
            )
        if current and len(phonemes_of(current + sentence)) > CONTEXT_PHONEMES:
            chunks.append(phonemes_of(current))
            current = []
        current = current + sentence
    if current:
        chunks.append(phonemes_of(current))
    return [chunk for chunk in chunks if chunk]


# ---------------------------------------------------------------------------
# Runtime (heavy imports are lazy)
# ---------------------------------------------------------------------------


def enforce_offline() -> None:
    """Pin the offline switches before any heavy import; an explicit opt-out fails closed."""
    for name in OFFLINE_VARIABLES:
        if os.environ.get(name, "1") != "1":
            fail(f"{name} must be 1: Kokoro generation is offline and never downloads")
        os.environ[name] = "1"


def require_spacy_model() -> None:
    # misaki downloads the spaCy model when it is missing; it must come from the hash-locked venv.
    package_version(SPACY_MODEL)
    import spacy.util

    if not spacy.util.is_package(SPACY_MODEL):
        fail(f"spaCy model {SPACY_MODEL!r} is not installed as a package; install requirements-kokoro.txt")


def probe() -> None:
    enforce_offline()
    versions = {name: package_version(name) for name in RUNTIME_PACKAGES}
    try:
        import torch
    except ImportError as error:
        fail(f"required Python package 'torch' could not be imported: {error}")
    components = [
        {"id": "asset-tooling.kokoro-adapter", "sha256": sha256_file(Path(__file__).resolve())},
        {
            "id": "python",
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executableSha256": sha256_file(Path(sys.executable).resolve()),
        },
        {"id": "platform", "system": platform.system(), "machine": platform.machine()},
        *({"id": name, "version": version} for name, version in versions.items()),
        {
            "id": "torch-cpu",
            "torchVersion": torch.__version__,
            "cudaVersion": torch.version.cuda,
            "mklAvailable": torch.backends.mkl.is_available(),
            "openmpAvailable": torch.backends.openmp.is_available(),
            "mkldnnAvailable": torch.backends.mkldnn.is_available(),
        },
    ]
    print(json.dumps(components, sort_keys=True, separators=(",", ":")))


def build_g2p(voice: str, entries: dict):
    require_spacy_model()
    from misaki import en

    british = voice.startswith("b")
    # fallback=None: no espeak. unk keeps unresolved words visible for require_in_vocabulary.
    g2p = en.G2P(trf=False, british=british, fallback=None, unk=UNKNOWN_MARKER)
    vocabulary = en.GB_VOCAB if british else en.US_VOCAB
    for word, phonemes in entries.items():
        invalid = sorted({character for character in phonemes if character not in vocabulary})
        if invalid:
            fail(f"lexicon entry {word!r} uses phoneme(s) outside misaki's {'GB' if british else 'US'} set: {''.join(invalid)!r}")
    # Caller lexicon overrides misaki's dictionaries, including its capitalisation variants.
    g2p.lexicon.golds.update(en.Lexicon.grow_dictionary(dict(entries)))
    g2p.lexicon.golds.update(entries)
    return g2p


def generate(request_path: Path, output_path: Path, observations_path: Path) -> None:
    enforce_offline()
    request = read_request(request_path)
    voice = request["voice"]
    threads = request["threads"]
    seed = int(request["seed"])
    lexicon = request["lexicon"]

    g2p = build_g2p(voice, lexicon["entries"])
    tokens = []
    for paragraph in re.split(r"\n+", request["prompt"].strip()):
        if paragraph.strip():
            _, paragraph_tokens = g2p(paragraph.strip())
            tokens.extend(paragraph_tokens)
    require_in_vocabulary(tokens)
    chunks = chunk_tokens(tokens)
    if not chunks:
        fail("Kokoro prompt produced no phonemes")

    import torch

    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass

    with tempfile.TemporaryDirectory(prefix="asset-tooling-kokoro-bundle-") as scratch:
        root = Path(scratch)
        extract_bundle_members(Path(request["modelBundlePath"]), voice, root)
        verify_model_bundle(root, voice)

        from kokoro import KModel

        config = json.loads((root / "config.json").read_text(encoding="utf-8"))
        vocabulary = config["vocab"]
        for chunk in chunks:
            missing = sorted({character for character in chunk if character not in vocabulary})
            if missing:
                fail(f"phonemes outside the Kokoro vocabulary would be dropped: {''.join(missing)!r}")

        model = KModel(repo_id=MODEL_ID, config=config, model=str(root / WEIGHTS_FILE)).to("cpu").eval()
        pack = torch.load(root / "voices" / f"{voice}.pt", map_location="cpu", weights_only=True)

        torch.manual_seed(seed)
        pieces = []
        with torch.no_grad():
            for chunk in chunks:
                audio = model(chunk, pack[len(chunk) - 1], float(request["speed"]))
                pieces.append(audio.detach().to(torch.float32).reshape(-1).cpu().numpy())

    import numpy

    samples = numpy.concatenate(pieces) if len(pieces) > 1 else pieces[0]
    if samples.size == 0:
        fail("Kokoro produced no audio samples")
    pcm = float_to_pcm16(samples)
    write_wav(output_path, pcm)
    observations = {
        "voice": voice,
        "voiceSha256": PINNED_VOICES[voice],
        "weightsSha256": PINNED_FILES[WEIGHTS_FILE],
        "lexiconVersion": lexicon["version"],
        "lexiconEntries": len(lexicon["entries"]),
        "seed": request["seed"],
        "threads": threads,
        "speed": request["speed"],
        "sampleRate": SAMPLE_RATE,
        "frames": len(pcm) // 2,
        "phonemes": chunks,
        "g2p": {"engine": "misaki.en.G2P", "british": voice.startswith("b"), "fallback": None},
        "pcm": "float32-clip-scale32767-rint-int16le",
    }
    observations_path.write_text(json.dumps(observations, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv: list[str]) -> None:
    if argv == ["probe"]:
        probe()
        return
    if len(argv) == 4 and argv[0] == "generate":
        generate(Path(argv[1]), Path(argv[2]), Path(argv[3]))
        return
    fail("usage: kokoro_tts.py probe | generate REQUEST OUTPUT OBSERVATIONS")


if __name__ == "__main__":
    main(sys.argv[1:])
