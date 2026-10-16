/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#30 (Kokoro-82M speech adapter):
 * the Python adapter, its runtime lock and its evidence documentation. Runs in CI without torch,
 * kokoro, misaki, spaCy or the model.
 *
 * Public seams targeted (Python, `adapters/python/kokoro_tts.py`):
 *
 *   The module speaks the process-adapter protocol (`kokoro_tts.py probe` /
 *   `kokoro_tts.py generate REQUEST OUTPUT OBSERVATIONS`, see src/process-adapter.ts) and must be
 *   importable with only the standard library: torch, kokoro, misaki and spaCy are imported
 *   lazily inside probe/generate, so the pure seams below run under a bare `python3 -I`.
 *
 *   find_out_of_vocabulary(tokens) -> list[str]
 *     `tokens` are misaki G2P tokens (`misaki.en.G2P(...)(text)` returns `(phonemes, tokens)`;
 *     each MToken has `.text` and `.phonemes`). A token is out of vocabulary when its text
 *     contains a letter or digit and its `.phonemes` is None, empty, or contains misaki's unknown
 *     marker "❓". Punctuation without phonemes is not OOV. Returns each OOV token text once, in
 *     first-occurrence order. CI drives it with stub tokens (types.SimpleNamespace), so OOV
 *     detection does not need misaki here. The lexicon is applied before G2P, so a word that has
 *     a lexicon entry comes back with phonemes; the seam therefore needs no lexicon argument.
 *
 *   require_in_vocabulary(tokens) -> None
 *     Fails closed (raises, or exits non-zero like the other adapters' `fail`) when
 *     find_out_of_vocabulary(tokens) is non-empty, with a diagnostic containing
 *     "out-of-vocabulary" and naming every OOV token. generate() must call it before synthesis:
 *     no silent drop and no espeak fallback.
 *
 *   verify_model_bundle(root: pathlib.Path, voice: str) -> None
 *     Checks the extracted acquisition bundle against the pinned revision: `kokoro-v1_0.pth`
 *     must have SHA-256 496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4 and
 *     `voices/<voice>.pt` must exist (and, for af_heart, match
 *     0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff). Fails closed naming
 *     the offending file.
 *
 * Runtime lock: `requirements-kokoro.txt` at the repository root, a hash-locked requirements file
 * for a uv-managed Python 3.12 venv (`uv pip install --require-hashes -r requirements-kokoro.txt`).
 * Every requirement is pinned (`==` or a direct `@` URL) with at least one `--hash=sha256:`, and it
 * pins torch, kokoro, misaki, spaCy and en_core_web_sm (so misaki never downloads it at runtime).
 *
 * Documentation: `docs/kokoro.md` (linked from docs/audio.md) records the pinned model and
 * revision, the Apache-2.0 licence, the training-data provenance caveat accepted by
 * interactive-videos Decision 3.24, the acquisition command, the approximate reproducibility, and
 * the local acceptance environment variables.
 *
 * The static source checks are deliberately coarse, in the style of test/triposr.test.ts: they
 * catch a missing pin or a download path, not every bug.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ADAPTERS = path.join(REPO, "adapters", "python");
const SCRIPT = path.join(ADAPTERS, "kokoro_tts.py");
const PINNED_WEIGHTS_SHA256 = "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4";

function findPython(): string | undefined {
  for (const candidate of [process.env.ASSET_TOOLING_PYTHON, "python3", "python"]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() === "3") return candidate;
  }
  return undefined;
}

const PYTHON = findPython();
const NO_PYTHON = PYTHON === undefined && "a Python 3 interpreter (python3/python or ASSET_TOOLING_PYTHON) is required";

/** Run a snippet with kokoro_tts imported from adapters/python, isolated from site/user paths. */
function runPython(body: string) {
  const program = [
    "import json, sys, types, pathlib",
    `sys.path.insert(0, ${JSON.stringify(ADAPTERS)})`,
    "import kokoro_tts",
    "T = lambda text, phonemes, whitespace=' ': types.SimpleNamespace(text=text, phonemes=phonemes, whitespace=whitespace)",
    body,
  ].join("\n");
  return spawnSync(PYTHON!, ["-I", "-c", program], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
}

function source() {
  assert.ok(existsSync(SCRIPT), "adapters/python/kokoro_tts.py must exist (#30)");
  return readFileSync(SCRIPT, "utf8");
}

// ---------------------------------------------------------------------------
// Pure Python seams
// ---------------------------------------------------------------------------

test("kokoro_tts.py imports with the standard library only (heavy deps are lazy)", { skip: NO_PYTHON }, () => {
  source();
  const result = runPython(
    [
      "assert 'torch' not in sys.modules and 'kokoro' not in sys.modules and 'misaki' not in sys.modules and 'spacy' not in sys.modules",
      "for name in ('find_out_of_vocabulary', 'require_in_vocabulary', 'verify_model_bundle', 'probe', 'generate', 'main'):",
      "    assert callable(getattr(kokoro_tts, name, None)), name",
      "print('ok')",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

test("find_out_of_vocabulary reports unresolved word tokens once, in order, and ignores punctuation", { skip: NO_PYTHON }, () => {
  source();
  const result = runPython(
    [
      "tokens = [",
      "  T('The', 'ðə'), T('Arius', None), T(',', None, ''), T('controversy', 'kˌɑntɹəvˈɜɹsi'),",
      "  T('homoousios', ''), T('at', 'æt'), T('Nicaea', '❓'), T('325', None), T('—', None), T('Arius', None), T('.', '.', ''),",
      "]",
      "print(json.dumps(kokoro_tts.find_out_of_vocabulary(tokens)))",
      "print(json.dumps(kokoro_tts.find_out_of_vocabulary([T('Athanasius', 'ˌæθənˈAʃəs'), T('.', None, '')])))",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const [unresolved, resolved] = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(unresolved, ["Arius", "homoousios", "Nicaea", "325"]);
  assert.deepEqual(resolved, []);
});

test("require_in_vocabulary fails closed naming every out-of-vocabulary token", { skip: NO_PYTHON }, () => {
  source();
  const failing = runPython(
    [
      "try:",
      "    kokoro_tts.require_in_vocabulary([T('Hosius', None), T('of', 'ʌv'), T('Bithynia', None), T('.', None, '')])",
      "except SystemExit as error:",
      "    sys.exit(3 if error.code not in (0, None) else 0)",
      "except Exception as error:",
      "    print(str(error), file=sys.stderr)",
      "    sys.exit(4)",
      "print('accepted')",
    ].join("\n"),
  );
  assert.notEqual(failing.status, 0, "unknown words must not be accepted");
  assert.ok(!failing.stdout.includes("accepted"));
  const diagnostic = `${failing.stderr}\n${failing.stdout}`;
  assert.match(diagnostic, /out-of-vocabulary/i);
  assert.match(diagnostic, /Hosius/);
  assert.match(diagnostic, /Bithynia/);

  const passing = runPython("kokoro_tts.require_in_vocabulary([T('Arius', 'ˈɛɹiəs'), T('.', None, '')]); print('accepted')");
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(passing.stdout.trim(), "accepted");
});

test("verify_model_bundle rejects weights that are not the pinned kokoro-v1_0.pth", { skip: NO_PYTHON }, () => {
  source();
  const root = mkdtempSync(path.join(os.tmpdir(), "asset-tooling-kokoro-bundle-"));
  try {
    mkdirSync(path.join(root, "voices"));
    writeFileSync(path.join(root, "config.json"), "{}\n");
    writeFileSync(path.join(root, "kokoro-v1_0.pth"), "not the pinned weights");
    writeFileSync(path.join(root, "voices", "af_heart.pt"), "not the pinned voice");
    assert.notEqual(createHash("sha256").update("not the pinned weights").digest("hex"), PINNED_WEIGHTS_SHA256);
    const result = runPython(
      [
        "try:",
        `    kokoro_tts.verify_model_bundle(pathlib.Path(${JSON.stringify(root)}), 'af_heart')`,
        "except SystemExit as error:",
        "    sys.exit(3 if error.code not in (0, None) else 0)",
        "except Exception as error:",
        "    print(str(error), file=sys.stderr)",
        "    sys.exit(4)",
        "print('accepted')",
      ].join("\n"),
    );
    assert.notEqual(result.status, 0, "an unpinned weights file must be rejected");
    assert.match(`${result.stderr}\n${result.stdout}`, /kokoro-v1_0\.pth/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("usage errors exit non-zero without importing the runtime", { skip: NO_PYTHON }, () => {
  source();
  const result = spawnSync(PYTHON!, ["-I", SCRIPT, "synthesize"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage/i);
});

// ---------------------------------------------------------------------------
// Static checks of the Python adapter
// ---------------------------------------------------------------------------

test("the Python adapter pins the model, loads weights safely and never reaches a download path", () => {
  const text = source();
  assert.match(text, /f3ff3571791e39611d31c381e3a41a3af07b4987/, "pinned Hugging Face revision");
  assert.match(text, new RegExp(PINNED_WEIGHTS_SHA256), "pinned kokoro-v1_0.pth SHA-256");
  assert.match(text, /weights_only\s*=\s*True/, "torch.load must use weights_only=True");
  assert.match(text, /HF_HUB_OFFLINE/);
  assert.match(text, /TRANSFORMERS_OFFLINE/);
  assert.match(text, /en_core_web_sm/, "the spaCy model must be checked as an installed dependency");
  assert.doesNotMatch(text, /hf_hub_download|snapshot_download/, "no Hugging Face download path");
  assert.doesNotMatch(text, /spacy\.cli|spacy\s+download|cli\.download/, "no spaCy model download path");
  assert.doesNotMatch(text, /EspeakFallback|espeak\.EspeakG2P/, "no espeak fallback: unknown words fail closed");
  assert.doesNotMatch(text, /urllib\.request|requests\.get|http\.client/, "no network client");
  assert.match(text, /require_in_vocabulary\(/, "generate must check lexicon coverage");
  assert.match(text, /manual_seed\(/, "the request seed must seed torch");
  assert.match(text, /set_num_threads\(/, "the thread count must be fixed");
  assert.match(text, /24000|24_000/, "24 kHz output");
});

// ---------------------------------------------------------------------------
// Hash-locked runtime and evidence docs
// ---------------------------------------------------------------------------

function requirementEntries(text: string) {
  const logical = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  return logical
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("-"));
}

test("requirements-kokoro.txt is a fully hash-locked runtime including en_core_web_sm", () => {
  const file = path.join(REPO, "requirements-kokoro.txt");
  assert.ok(existsSync(file), "requirements-kokoro.txt must exist (#30)");
  const entries = requirementEntries(readFileSync(file, "utf8"));
  assert.ok(entries.length > 0);
  const names = new Set<string>();
  for (const entry of entries) {
    const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(entry)?.[1];
    assert.ok(name, `unparseable requirement: ${entry}`);
    assert.ok(/==|\s@\s/.test(entry), `${name} must be pinned to an exact version or URL`);
    assert.match(entry, /--hash=sha256:[0-9a-f]{64}/, `${name} must carry a sha256 hash`);
    names.add(name.toLowerCase().replace(/[-_.]+/g, "-"));
  }
  for (const required of ["torch", "kokoro", "misaki", "spacy", "en-core-web-sm"]) {
    assert.ok(names.has(required), `requirements-kokoro.txt must pin ${required}`);
  }
});

test("docs/kokoro.md records the model, licence, provenance caveat, acquisition and local run", () => {
  const file = path.join(REPO, "docs", "kokoro.md");
  assert.ok(existsSync(file), "docs/kokoro.md must exist (#30)");
  const text = readFileSync(file, "utf8");
  assert.match(text, /hexgrad\/Kokoro-82M/);
  assert.match(text, /f3ff3571791e39611d31c381e3a41a3af07b4987/);
  assert.match(text, /Apache-2\.0/i);
  assert.match(text, /synthetic/i, "the training-data provenance caveat must travel with the licence evidence");
  assert.match(text, /3\.24/, "interactive-videos Decision 3.24");
  assert.match(text, /acquire-huggingface-model\.py[\s\S]*--expected-license apache-2\.0/);
  assert.match(text, /requirements-kokoro\.txt/);
  assert.match(text, /approximate/);
  assert.match(text, /ASSET_TOOLING_KOKORO_PYTHON/);
  assert.match(text, /ASSET_TOOLING_KOKORO_MODEL_ZIP/);
  assert.match(readFileSync(path.join(REPO, "docs", "audio.md"), "utf8"), /kokoro\.md/, "docs/audio.md must link the Kokoro page");
});
