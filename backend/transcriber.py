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

import logging
import os
import urllib.request
from pathlib import Path
from typing import Callable

from storage import DATA_ROOT

HF_MIRROR = "https://hf-mirror.com"
DEFAULT_MODEL_SIZE = "small"

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

from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)


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

    def ensure_model(self) -> bool:
        """确保模型可用（必要时联网下载，下载源已在模块导入时决定）。返回是否就绪。

        供启动器 preload.py 预下载用；失败不抛出，返回 False 即可（首次转写会再试）。
        """
        try:
            self._load_model()
            return True
        except Exception:
            logger.warning("模型准备失败", exc_info=True)
            return False

    def _load_model(self) -> WhisperModel:
        if self._model is not None:
            return self._model
        self._model = WhisperModel(self.model_ref, device=self.device, compute_type=self.compute_type)
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