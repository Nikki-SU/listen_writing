"""转写引擎：可插拔 ASR 抽象 + faster-whisper 实现。

设计目标（见《工程纪律.md》「世界观先于方法论」）：
- 转写引擎可替换：上层只依赖 Transcriber 抽象，换引擎不牵动 storage / main。
- 模型可替换：用户本地路径优先，其次 size 名（small 等）自动下载。
- 下载源对用户零配置：默认官方 HuggingFace，失败自动降级国内镜像 hf-mirror.com。

模型查找顺序（用户零配置，离线也能用）：
1. 环境变量 LISTEN_WRITING_MODEL 指向的本地 ctranslate2 模型目录（若有）。
2. `data/models/whisper-<size>/` 下的离线模型（用户自行放入即可离线使用）。
3. 交给 faster-whisper 按 size 名自动下载（官方 HuggingFace → 失败降级 hf-mirror.com）。

配置（环境变量，引导部署的启动器可设）：
- LISTEN_WRITING_MODEL：本地 ctranslate2 模型目录路径（优先级最高）。
- LISTEN_WRITING_MODEL_SIZE：size 名（tiny/base/small/medium/large-v3），默认 small。
"""

import logging
import os
from typing import Callable

# 网络环境兜底（必须在导入 huggingface_hub 之前设置）：
# - 官方 HuggingFace 在国内常被屏蔽，把探测超时压短，失败能快速切换镜像；
# - hf-mirror 多为普通 HTTP 镜像，不支持 xet 传输，关掉 xet 避免多绕一层。
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "5")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "20")
# Windows 非管理员/未开开发者模式时 HuggingFace 无法建符号链接，会刷一大段英文警告，
# 用户会误以为是报错；缓存本身照样可用，直接关掉这条警告。
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from faster_whisper import WhisperModel

from storage import DATA_ROOT

logger = logging.getLogger(__name__)

HF_MIRROR = "https://hf-mirror.com"
DEFAULT_MODEL_SIZE = "small"


def offline_model_dir(size: str) -> str:
    """离线模型目录约定：data/models/whisper-<size>/。"""
    return str(DATA_ROOT / "models" / f"whisper-{size}")


class Transcriber:
    """转写抽象：返回句子列表，每句含 start_ms / end_ms / text / speaker。"""

    def transcribe(self, audio_path: str, on_progress: Callable[[int], None] | None = None) -> list[dict]:
        raise NotImplementedError


class FasterWhisperTranscriber(Transcriber):
    def __init__(self, device: str = "cpu", compute_type: str = "int8"):
        self.size = os.environ.get("LISTEN_WRITING_MODEL_SIZE") or DEFAULT_MODEL_SIZE
        self.explicit_model = os.environ.get("LISTEN_WRITING_MODEL")
        self.device = device
        self.compute_type = compute_type
        self._model: WhisperModel | None = None

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
        """非本地目录（即 size 名）需要联网下载模型。"""
        return not os.path.isdir(os.path.expanduser(self.model_ref))

    def ensure_model(self) -> bool:
        """确保模型可用（必要时联网下载，失败自动切镜像）。返回是否就绪。

        供启动器 preload.py 预下载用；失败不抛出，返回 False 即可（首次转写会再试）。
        """
        try:
            self._load_model()
            return True
        except Exception:
            logger.warning("模型准备失败", exc_info=True)
            return False

    def _fallback_to_mirror(self) -> None:
        """把 HuggingFace 下载源切到国内镜像（用户零配置，仅作可用性兜底）。"""
        os.environ["HF_ENDPOINT"] = HF_MIRROR
        os.environ["HF_HUB_DISABLE_XET"] = "1"
        try:
            import huggingface_hub.constants as hc
            hc.ENDPOINT = HF_MIRROR
        except Exception:  # pragma: no cover - 版本差异保护，不影响主流程
            logger.warning("无法切换 huggingface_hub 镜像常量，依赖 HF_ENDPOINT 环境变量", exc_info=True)

    def _load_model(self) -> WhisperModel:
        if self._model is not None:
            return self._model
        try:
            self._model = WhisperModel(self.model_ref, device=self.device, compute_type=self.compute_type)
        except Exception:
            if os.environ.get("HF_ENDPOINT") is None and self.needs_download():
                logger.info("官方源下载失败，自动切换 hf-mirror.com 重试")
                self._fallback_to_mirror()
                self._model = WhisperModel(self.model_ref, device=self.device, compute_type=self.compute_type)
            else:
                raise
        return self._model

    def transcribe(self, audio_path: str, on_progress: Callable[[int], None] | None = None) -> list[dict]:
        model = self._load_model()
        segments, info = model.transcribe(audio_path, beam_size=5)
        duration = float(info.duration or 1.0)
        sentences: list[dict] = []
        for seg in segments:
            sentences.append({
                "start_ms": int(round(seg.start * 1000)),
                "end_ms": int(round(seg.end * 1000)),
                "text": seg.text.strip(),
                "speaker": "",
            })
            if on_progress:
                on_progress(min(100, int(seg.end / duration * 100)))
        if on_progress:
            on_progress(100)
        return sentences


def default_transcriber() -> Transcriber:
    return FasterWhisperTranscriber()