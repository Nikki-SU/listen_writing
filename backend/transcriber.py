"""转写引擎：可插拔 ASR 抽象 + faster-whisper 实现。

设计目标（见《工程纪律.md》「世界观先于方法论」）：
- 转写引擎可替换：上层只依赖 Transcriber 抽象，换引擎不牵动 storage / main。
- 模型可替换：用户本地路径优先，其次 size 名（small 等）自动下载。
- 下载源对用户零配置：导入时探测官方 HuggingFace 端点，不通自动改用国内镜像 hf-mirror.com。

模型查找顺序（用户零配置，离线也能用）：
1. 环境变量 LISTEN_WRITING_MODEL 指向的本地 ctranslate2 模型目录（若有）。
2. `data/models/whisper-<size>/` 下的离线模型（用户自行放入即可离线使用）。
3. 交给 faster-whisper 按 size 名自动下载，缓存也放在项目文件夹内
   （`data/models/hf-cache/`；官方 HuggingFace 探测不通时改用 hf-mirror.com）。
   这样换电脑 / 换盘时把整个文件夹拷走即可，模型不用重下。

配置（环境变量，引导部署的启动器可设）：
- LISTEN_WRITING_MODEL：本地 ctranslate2 模型目录路径（优先级最高）。
- LISTEN_WRITING_MODEL_SIZE：size 名（tiny/base/small/medium/large-v3），默认 small。
"""

import importlib.util
import logging
import os
import shutil
import tarfile
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Callable

from storage import DATA_ROOT

HF_MIRROR = "https://hf-mirror.com"
DEFAULT_MODEL_SIZE = "small"

# SenseVoice Small（sherpa-onnx int8，约 229MB）：官方发布包同时含 fp32 与 int8，
# 下载后只保留 int8，把 895MB 的 fp32 删掉，兑现 PRD「极轻」的定位。
SENSEVOICE_PACKAGE = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
SENSEVOICE_DIR = DATA_ROOT / "models" / "sensevoice" / SENSEVOICE_PACKAGE
SENSEVOICE_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    f"{SENSEVOICE_PACKAGE}.tar.bz2"
)

# Qwen3-ASR-0.6B（官方 Transformers 原生权重，约 1.2GB）。0.6B fp32 在 CPU 上约 2.5GB 内存。
QWEN_ASR_REPO = "Qwen/Qwen3-ASR-0.6B-hf"
QWEN_ASR_DIR = DATA_ROOT / "models" / "qwen3-asr-0.6b"

_MODEL_LOCK = threading.Lock()

# ASR 选项（PRD 第 7 节三选项）。这里是唯一权威定义：
# - 设置接口 S-1 直接把这份表返回给前端渲染，前后端不会各写一份标签而不一致；
# - `available` 表示本机运行时是否已内置，未内置的选项在设置页置灰并说明原因，
#   真选了也只会得到明确报错，不会假装转写成功。
ASR_MODELS: dict[str, dict] = {
    "whisper-small": {
        "id": "whisper-small",
        "label": "Whisper small",
        "engine": "faster-whisper",
        "size": "small",
        "min_ram": "8GB",
        "speed": "约 1.5–2 倍实时",
        "note": "通用兜底，生态成熟；默认档",
        "available": True,
    },
    "whisper-medium": {
        "id": "whisper-medium",
        "label": "Whisper medium",
        "engine": "faster-whisper",
        "size": "medium",
        "min_ram": "16GB",
        "speed": "约 2–3 倍实时",
        "note": "通用兜底，精度更高、更占内存",
        "available": True,
    },
    "qwen3-asr-0.6b": {
        "id": "qwen3-asr-0.6b",
        "label": "Qwen3-ASR-0.6B",
        "engine": "qwen3-asr",
        "size": "0.6b",
        "min_ram": "8GB",
        "speed": "约 2.5GB 内存占用",
        "note": "中文方言平衡（22 种中文方言）",
        "available": True,
    },
    "sensevoice-small": {
        "id": "sensevoice-small",
        "label": "SenseVoice Small",
        "engine": "sensevoice",
        "size": "small",
        "min_ram": "4GB",
        "speed": "峰值 <800MB，极轻",
        "note": "轻量快速，中文/粤语准确率好",
        "available": True,
    },
}

DEFAULT_ASR_MODEL = "whisper-small"


def _runtime_available(engine: str) -> bool:
    """本机是否装了该引擎需要的运行时（依赖由启动器安装）。"""
    if engine == "faster-whisper":
        return True
    if engine == "sensevoice":
        return importlib.util.find_spec("sherpa_onnx") is not None
    if engine == "qwen3-asr":
        return (
            importlib.util.find_spec("torch") is not None
            and importlib.util.find_spec("transformers") is not None
        )
    return False


def asr_options() -> list[dict]:
    """设置页的 ASR 选项：`available` 按本机运行时实际情况计算，不假装可用。"""
    options = []
    for spec in ASR_MODELS.values():
        item = dict(spec)
        item["available"] = _runtime_available(item["engine"])
        if not item["available"]:
            item["note"] = "本机运行时未安装；重新运行启动器可自动补装"
        options.append(item)
    return options

# 模型缓存跟随项目文件夹，而不是默认的 C:\Users\<用户>\.cache\huggingface：
# - 用户把文件夹拷到另一台电脑，模型跟着走，不用重新下载 500MB；
# - 不会在系统盘悄悄占空间，用户看得见它有多大。
# 用户自己设了 HF_HOME 时尊重用户设置（setdefault 不覆盖）。
os.environ.setdefault("HF_HOME", str(DATA_ROOT / "models" / "hf-cache"))

# 网络环境兜底（必须在导入 huggingface_hub 之前设置）：
# - 官方 HuggingFace 在国内常被屏蔽，把探测超时压短，失败能快速切换镜像；
# - hf-mirror 多为普通 HTTP 镜像，不支持 xet 传输，关掉 xet 避免多绕一层。
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "5")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "20")
# Windows 非管理员/未开开发者模式时 HuggingFace 无法建符号链接，会刷一大段英文警告，
# 用户会误以为是报错；缓存本身照样可用，直接关掉这条警告。
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def _hf_official_reachable(timeout: float = 3.0) -> bool:
    """官方端点是否可用（HEAD 一个模型元数据接口，不做实际下载）。"""
    url = "https://huggingface.co/api/models/Systran/faster-whisper-tiny"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


# 国内网络下官方端点常不可达。端点必须在导入 huggingface_hub 之前定下来：
# 实测 huggingface_hub 1.x 在进程运行中改 ENDPOINT 常量不生效（仍走旧地址），
# 所以这里先探测一次，不通就直接改用国内镜像，而不是等下载失败后再切。
if "HF_ENDPOINT" not in os.environ and not _hf_official_reachable():
    os.environ["HF_ENDPOINT"] = HF_MIRROR
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

logger = logging.getLogger(__name__)


def offline_model_dir(size: str) -> str:
    """离线模型目录约定：data/models/whisper-<size>/。"""
    return str(DATA_ROOT / "models" / f"whisper-{size}")


def _download_with_mirrors(url: str, dest: Path) -> None:
    """下载到 dest；官方 GitHub 不通时依次尝试国内代理，全部失败才抛错。"""
    candidates = [url, f"https://gh-proxy.com/{url}", f"https://ghproxy.net/{url}"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for candidate in candidates:
        tmp = dest.with_name(dest.name + ".part")
        try:
            with urllib.request.urlopen(candidate, timeout=30) as resp, tmp.open("wb") as f:
                total = int(resp.headers.get("Content-Length") or 0)
                done = 0
                while True:
                    block = resp.read(1024 * 1024)
                    if not block:
                        break
                    f.write(block)
                    done += len(block)
                    if total:
                        print(f"\r[模型] {dest.name} {done * 100 // total}%", end="", flush=True)
            if total and tmp.stat().st_size != total:
                raise IOError("下载不完整")
            tmp.replace(dest)
            print()
            return
        except Exception as exc:  # 换下一个源
            last_error = exc
            print(f"\n[模型] 下载源不可用：{candidate}")
            if tmp.exists():
                tmp.unlink()
    raise RuntimeError(f"模型下载失败：{last_error}")


def _ensure_sensevoice(on_status: Callable[[str], None] | None = None) -> bool:
    model = SENSEVOICE_DIR / "model.int8.onnx"
    tokens = SENSEVOICE_DIR / "tokens.txt"
    if model.is_file() and tokens.is_file():
        return True
    with _MODEL_LOCK:
        if model.is_file() and tokens.is_file():
            return True
        if on_status:
            on_status("正在下载 SenseVoice Small（约 1GB 发布包，解压后仅保留 229MB int8 模型）…")
        print("[模型] 正在下载 SenseVoice Small（约 1GB 发布包，解压后仅保留 229MB int8 模型）……")
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir) / f"{SENSEVOICE_PACKAGE}.tar.bz2"
            _download_with_mirrors(SENSEVOICE_URL, archive)
            if on_status:
                on_status("正在解压 SenseVoice Small…")
            print("[模型] 正在解压 SenseVoice Small……")
            with tarfile.open(archive, "r:bz2") as tar:
                try:
                    tar.extractall(tmpdir, filter="data")
                except TypeError:  # Python < 3.12 没有 filter 参数
                    tar.extractall(tmpdir)
            extracted = Path(tmpdir) / SENSEVOICE_PACKAGE
            if not (extracted / "model.int8.onnx").is_file():
                raise RuntimeError("SenseVoice 发布包里没有 model.int8.onnx")
            if SENSEVOICE_DIR.exists():
                shutil.rmtree(SENSEVOICE_DIR)
            SENSEVOICE_DIR.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(extracted, SENSEVOICE_DIR)
            # 发布包里的 fp32 模型 895MB，产品只用 int8，删掉省磁盘。
            (SENSEVOICE_DIR / "model.onnx").unlink(missing_ok=True)
    return model.is_file()


def _ensure_qwen_asr(on_status: Callable[[str], None] | None = None) -> bool:
    if (QWEN_ASR_DIR / "model.safetensors").is_file():
        return True
    with _MODEL_LOCK:
        if (QWEN_ASR_DIR / "model.safetensors").is_file():
            return True
        from huggingface_hub import snapshot_download

        if on_status:
            on_status("正在下载 Qwen3-ASR-0.6B（约 1.2GB，首次较慢）…")
        print("[模型] 正在下载 Qwen3-ASR-0.6B（约 1.2GB，首次较慢）……")
        snapshot_download(
            repo_id=QWEN_ASR_REPO,
            local_dir=str(QWEN_ASR_DIR),
            allow_patterns=["*.json", "*.safetensors", "*.jinja", "*.txt"],
        )
    return (QWEN_ASR_DIR / "model.safetensors").is_file()


class Transcriber:
    """转写抽象：返回句子列表，每句含 start_ms / end_ms / text / speaker。"""

    def transcribe(
        self,
        audio_path: str,
        on_progress: Callable[[int], None] | None = None,
        on_sentence: Callable[[dict], None] | None = None,
    ) -> list[dict]:
        """返回完整句子列表；`on_sentence` 在每识别出一句时立即回调，供边转边出。"""
        raise NotImplementedError

    def needs_download(self) -> bool:
        return False

    def ensure_model(self, on_progress: Callable[[int], None] | None = None) -> bool:
        return True


class FasterWhisperTranscriber(Transcriber):
    def __init__(
        self, size: str | None = None, device: str = "cpu", compute_type: str = "int8"
    ):
        # 设置页选择的大小优先；没选时沿用环境变量 / 默认 small（兼容旧启动器）。
        self.size = size or os.environ.get("LISTEN_WRITING_MODEL_SIZE") or DEFAULT_MODEL_SIZE
        self.explicit_model = os.environ.get("LISTEN_WRITING_MODEL")
        self.device = device
        self.compute_type = compute_type
        self._model = None

    @property
    def model_ref(self) -> str:
        """本地模型目录优先（离线可用），否则用 size 名交给 faster-whisper 自动下载。"""
        if self.explicit_model:
            explicit = os.path.expanduser(self.explicit_model)
            if os.path.isdir(explicit):
                return explicit
        offline = offline_model_dir(self.size)
        if os.path.isdir(offline):
            return offline
        return self.size

    def needs_download(self) -> bool:
        """模型是否还没准备好。

        model_ref 是本地目录时直接判目录存在；是 size 名时，除了看目录，
        还要看 HuggingFace 缓存里是否已有下载完的 model.bin——否则每次启动
        都会打印「开始下载」，用户会以为每次都在重下 500MB。
        """
        ref = os.path.expanduser(self.model_ref)
        if os.path.isdir(ref):
            return False
        # 与 huggingface_hub 的优先级一致：HF_HUB_CACHE > HF_HOME/hub
        cache_dir = os.environ.get("HF_HUB_CACHE") or os.path.join(
            os.environ.get("HF_HOME", str(DATA_ROOT / "models" / "hf-cache")), "hub"
        )
        cache_root = Path(cache_dir) / f"models--Systran--faster-whisper-{self.size}" / "snapshots"
        if cache_root.is_dir():
            for snapshot in cache_root.iterdir():
                if (snapshot / "model.bin").is_file():
                    return False
        return True

    def ensure_model(self, on_progress: Callable[[int], None] | None = None) -> bool:
        """确保模型可用（必要时联网下载，下载源已在模块导入时决定）。返回是否就绪。

        供启动器 preload.py 预下载用；失败不抛出，返回 False 即可（首次转写会再试）。
        """
        try:
            self._load_model()
            return True
        except Exception:
            logger.warning("模型准备失败", exc_info=True)
            return False

    def _load_model(self):
        if self._model is not None:
            return self._model
        from faster_whisper import WhisperModel

        self._model = WhisperModel(self.model_ref, device=self.device, compute_type=self.compute_type)
        return self._model

    def transcribe(
        self,
        audio_path: str,
        on_progress: Callable[[int], None] | None = None,
        on_sentence: Callable[[dict], None] | None = None,
    ) -> list[dict]:
        model = self._load_model()
        segments, info = model.transcribe(audio_path, beam_size=5)
        duration = float(info.duration or 1.0)
        sentences: list[dict] = []
        for seg in segments:
            sentence = {
                "start_ms": int(round(seg.start * 1000)),
                "end_ms": int(round(seg.end * 1000)),
                "text": seg.text.strip(),
                "speaker": "",
            }
            sentences.append(sentence)
            if on_sentence:
                on_sentence(sentence)
            if on_progress:
                on_progress(min(100, int(seg.end / duration * 100)))
        if on_progress:
            on_progress(100)
        return sentences


class SenseVoiceTranscriber(Transcriber):
    """SenseVoice Small（sherpa-onnx int8）：轻量、中文/粤语准确率好。

    识别器本身不给时间戳，所以先用 audio.split_speech 按静音切句，再逐句识别。
    """

    def __init__(self) -> None:
        self._recognizer = None
        self._lock = threading.Lock()

    def needs_download(self) -> bool:
        return not (SENSEVOICE_DIR / "model.int8.onnx").is_file()

    def ensure_model(self, on_progress: Callable[[int], None] | None = None) -> bool:
        try:
            _ensure_sensevoice()
            return True
        except Exception:
            logger.warning("SenseVoice 模型准备失败", exc_info=True)
            return False

    def _load(self):
        if self._recognizer is not None:
            return self._recognizer
        with self._lock:
            if self._recognizer is not None:
                return self._recognizer
            _ensure_sensevoice()
            import sherpa_onnx

            model = str(SENSEVOICE_DIR / "model.int8.onnx")
            tokens = str(SENSEVOICE_DIR / "tokens.txt")
            self._recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=model,
                tokens=tokens,
                num_threads=max(1, min(4, os.cpu_count() or 2)),
                use_itn=True,
                language="auto",
                debug=False,
            )
            return self._recognizer

    def transcribe(
        self,
        audio_path: str,
        on_progress: Callable[[int], None] | None = None,
        on_sentence: Callable[[dict], None] | None = None,
    ) -> list[dict]:
        from audio import decode_audio, split_speech

        recognizer = self._load()
        samples = decode_audio(audio_path)
        if samples.size == 0:
            return []
        regions = split_speech(samples)
        sentences: list[dict] = []
        total = max(1, samples.size)
        for start, end in regions:
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, samples[start:end])
            recognizer.decode_stream(stream)
            text = (stream.result.text or "").strip()
            if text:
                sentence = {
                    "start_ms": int(start / 16000 * 1000),
                    "end_ms": int(end / 16000 * 1000),
                    "text": text,
                    "speaker": "",
                }
                sentences.append(sentence)
                if on_sentence:
                    on_sentence(sentence)
            if on_progress:
                on_progress(min(99, int(end / total * 100)))
        if on_progress:
            on_progress(100)
        return sentences


class Qwen3AsrTranscriber(Transcriber):
    """Qwen3-ASR-0.6B：中文方言平衡档，官方 Transformers 权重 + CPU 推理。

    同样是整段非流式模型，沿用静音切句获得句级时间戳。
    """

    def __init__(self) -> None:
        self._model = None
        self._processor = None
        self._lock = threading.Lock()

    def needs_download(self) -> bool:
        return not (QWEN_ASR_DIR / "model.safetensors").is_file()

    def ensure_model(self, on_progress: Callable[[int], None] | None = None) -> bool:
        try:
            _ensure_qwen_asr()
            return True
        except Exception:
            logger.warning("Qwen3-ASR 模型准备失败", exc_info=True)
            return False

    def _load(self):
        if self._model is not None:
            return self._model, self._processor
        with self._lock:
            if self._model is not None:
                return self._model, self._processor
            _ensure_qwen_asr()
            import torch
            from transformers import AutoModelForMultimodalLM, AutoProcessor

            torch.set_num_threads(max(1, min(4, os.cpu_count() or 2)))
            self._processor = AutoProcessor.from_pretrained(str(QWEN_ASR_DIR))
            self._model = AutoModelForMultimodalLM.from_pretrained(
                str(QWEN_ASR_DIR), dtype=torch.float32
            )
            self._model.eval()
            return self._model, self._processor

    def _transcribe_chunk(self, samples) -> str:
        import torch

        model, processor = self._load()
        # 直接传内存里的 16kHz float32，避免处理器为了读文件再去依赖 librosa。
        inputs = processor.apply_transcription_request(audio=samples)
        inputs = inputs.to(model.device, model.dtype)
        with torch.inference_mode():
            generated = model.generate(**inputs, max_new_tokens=256)
        trimmed = generated[:, inputs["input_ids"].shape[1]:]
        decoded = processor.decode(trimmed, return_format="transcription_only")
        if isinstance(decoded, (list, tuple)):
            return str(decoded[0] if decoded else "").strip()
        return str(decoded or "").strip()

    def transcribe(
        self,
        audio_path: str,
        on_progress: Callable[[int], None] | None = None,
        on_sentence: Callable[[dict], None] | None = None,
    ) -> list[dict]:
        from audio import decode_audio, split_speech

        samples = decode_audio(audio_path)
        if samples.size == 0:
            return []
        regions = split_speech(samples)
        sentences: list[dict] = []
        total = max(1, samples.size)
        for start, end in regions:
            text = self._transcribe_chunk(samples[start:end])
            if text:
                sentence = {
                    "start_ms": int(start / 16000 * 1000),
                    "end_ms": int(end / 16000 * 1000),
                    "text": text,
                    "speaker": "",
                }
                sentences.append(sentence)
                if on_sentence:
                    on_sentence(sentence)
            if on_progress:
                on_progress(min(99, int(end / total * 100)))
        if on_progress:
            on_progress(100)
        return sentences


def transcriber_for(model_key: str) -> Transcriber:
    """按设置里的 `asr_model` 构建转写器。

    PRD 三档都必须真正可运行：Whisper / Qwen3-ASR / SenseVoice。
    """
    spec = ASR_MODELS.get(model_key)
    if spec is None:
        raise ValueError(f"未知的转写模型：{model_key}")
    if not _runtime_available(spec["engine"]):
        raise RuntimeError(f"「{spec['label']}」需要的运行时未安装，请重新运行启动器补装")
    if spec["engine"] == "faster-whisper":
        return FasterWhisperTranscriber(size=spec["size"])
    if spec["engine"] == "sensevoice":
        return SenseVoiceTranscriber()
    if spec["engine"] == "qwen3-asr":
        return Qwen3AsrTranscriber()
    raise RuntimeError(f"「{spec['label']}」没有可用的本地运行时")


def default_transcriber() -> Transcriber:
    """默认转写器：优先跟随 `data/settings.json` 里选中的模型。"""
    try:
        from storage import get_settings

        key = get_settings().get("asr_model") or DEFAULT_ASR_MODEL
        return transcriber_for(key)
    except Exception:
        # 读设置失败不能让转写整体不可用：退回最稳的 small。
        return FasterWhisperTranscriber()