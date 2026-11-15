"""音频解码与语音分段（ASR 引擎共用）。

为什么需要分段：
- SenseVoice / Qwen3-ASR 都是「非流式」识别器，整段喂进去只回一段文字；
- 产品要求句子级时间戳（点击句子跳转音频），所以这里先按静音切成语音片段，
  每个片段单独识别，片段起止时间就是句子时间。

解码统一用 PyAV（faster-whisper 同款解码层），支持 PRD 列出的 WAV/MP3/M4A/WMA。
"""

import io

import av
import numpy as np

SAMPLE_RATE = 16000


def decode_audio(path: str) -> np.ndarray:
    """把任意支持的音频解码成 16kHz 单声道 float32 波形。"""
    chunks: list[np.ndarray] = []
    with av.open(path) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise RuntimeError("文件里没有音频轨道")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32, copy=False)


def _frame_rms(samples: np.ndarray, hop: int) -> np.ndarray:
    count = max(0, len(samples) // hop)
    if count == 0:
        return np.zeros(0, dtype=np.float32)
    trimmed = samples[: count * hop].reshape(count, hop)
    return np.sqrt(np.mean(trimmed.astype(np.float32) ** 2, axis=1) + 1e-12)


def split_speech(
    samples: np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    max_sec: float = 20.0,
    min_speech_sec: float = 0.25,
    min_silence_sec: float = 0.35,
    pad_sec: float = 0.15,
) -> list[tuple[int, int]]:
    """按能量静音切分语音，返回 [(start_sample, end_sample), ...]。

    不追求学术级 VAD，只要能把一整段访谈切成「一句一段」并给出可跳转的时间。
    阈值取帧能量的低分位乘以系数，既能适应安静录音，也能适应有底噪的录音。
    """
    hop = int(sample_rate * 0.03)
    rms = _frame_rms(samples, hop)
    if rms.size == 0:
        return [(0, len(samples))] if len(samples) else []

    floor = float(np.percentile(rms, 20))
    peak = float(np.percentile(rms, 95))
    threshold = max(0.004, min(peak * 0.18, max(floor * 2.5, 0.006)))

    voiced = rms > threshold
    # 合并短停顿：小于 min_silence_sec 的静音并进同一段。
    min_silence_frames = max(1, int(min_silence_sec / 0.03))
    regions: list[list[int]] = []
    start = None
    silent_run = 0
    for index, is_voiced in enumerate(voiced):
        if is_voiced:
            if start is None:
                start = index
            silent_run = 0
        elif start is not None:
            silent_run += 1
            if silent_run >= min_silence_frames:
                regions.append([start, index - silent_run + 1])
                start = None
                silent_run = 0
    if start is not None:
        regions.append([start, len(voiced)])

    min_frames = max(1, int(min_speech_sec / 0.03))
    regions = [r for r in regions if r[1] - r[0] >= min_frames]
    if not regions:
        return [(0, len(samples))]

    pad = int(pad_sec * sample_rate)
    max_samples = int(max_sec * sample_rate)
    out: list[tuple[int, int]] = []
    for a, b in regions:
        start_sample = max(0, a * hop - pad)
        end_sample = min(len(samples), b * hop + pad)
        while end_sample - start_sample > max_samples:
            # 超长片段在中间附近找能量最低点切开，避免切断一句话。
            lo = start_sample + int(max_samples * 0.55)
            hi = start_sample + max_samples
            lo_frame = max(0, lo // hop)
            hi_frame = min(len(rms), max(lo_frame + 1, hi // hop))
            cut_frame = lo_frame + int(np.argmin(rms[lo_frame:hi_frame])) if hi_frame > lo_frame else lo_frame
            cut = min(end_sample, cut_frame * hop)
            if cut <= start_sample:
                cut = start_sample + max_samples
            out.append((start_sample, cut))
            start_sample = cut
        if end_sample > start_sample:
            out.append((start_sample, end_sample))
    return out


def wav_bytes(samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> bytes:
    """把 float32 波形写成 16bit PCM WAV 字节（部分识别器只接受 wav 文件路径）。"""
    import wave

    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()
