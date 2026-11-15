"""本地说话人聚类（无外部模型）。

思路：把每句对应的音频算成 MFCC 统计特征（13 维均值 + 13 维标准差），
再对句级特征做 k-means；用轮廓系数在 1..4 个说话人之间选最优 k。
只依赖 numpy + PyAV（本来就是转写依赖），不下载额外模型，符合「数据不出本机」。
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 16000
FRAME_MS = 25
HOP_MS = 10
N_FFT = 512
N_MELS = 26
N_MFCC = 13


def assign_speakers(audio_path: str, sentences: list[dict]) -> bool:
    """给句子写入 Speaker 1/2/…，返回是否成功完成聚类。"""
    if len(sentences) < 3:
        return False
    try:
        pcm = _load_pcm(audio_path)
        if pcm.size < SAMPLE_RATE:
            return False
        feats = []
        for s in sentences:
            start = int(s["start_ms"] * SAMPLE_RATE / 1000)
            end = int(s["end_ms"] * SAMPLE_RATE / 1000)
            feats.append(_sentence_feature(pcm, start, end))
        X = np.vstack(feats)
        labels = _pitch_groups(X)
        if labels is None:
            X = _standardize(X)
            k, labels = _choose_k(X)
        names = _label_names(labels, int(labels.max()) + 1)
        for s, label in zip(sentences, labels):
            s["speaker"] = names[int(label)]
        return True
    except Exception:
        # 聚类失败不应影响转写结果，保持未标注状态
        return False


def assign_from_features(features: list[np.ndarray]) -> list[str]:
    """用已经算好的句级特征在线分配说话人（实时录音每批重跑一次）。

    实时录音拿不到「整段音频」，但聚合已有的句级特征再做一次聚类，
    结论与整段结束后跑 `assign_speakers` 一致；句子越多越准。
    """
    if not features:
        return []
    if len(features) < 3:
        return ["Speaker 1"] * len(features)
    X = np.vstack(features)
    labels = _pitch_groups(X)
    if labels is None:
        X = _standardize(X)
        k, labels = _choose_k(X)
    names = _label_names(labels, int(labels.max()) + 1)
    return [names[int(label)] for label in labels]


# 基频分档：男/女声差 60–120Hz，同一人不同句子只差十几 Hz。
_PITCH_MIN_GAP_HZ = 20.0
_PITCH_MIN_GAP_RATIO = 0.12


def _pitch_groups(X: np.ndarray) -> np.ndarray | None:
    """先看基频是否天然分成两档；分得出就返回 0/1 标签，否则返回 None。

    这是实时录音里最可靠的一步：MFCC 在只有零点几秒的短句上很不稳定，
    而男/女声的基频差距远大于同一人不同句子的自然起伏。先按基频分档，
    既不会把单人录音拆成两个人，也不会把男女声都标成 Speaker 1。
    """
    pitch = X[:, -2]  # 特征最后一段是 [中位基频, 基频标准差]
    voiced = np.where(pitch > 0)[0]
    if len(voiced) < 4:
        return None
    values = np.sort(pitch[voiced])
    gaps = np.diff(values)
    split = int(np.argmax(gaps))
    gap = float(gaps[split])
    low, high = values[: split + 1], values[split + 1:]
    if len(low) < 2 or len(high) < 2:
        return None
    median = float(np.median(values))
    if gap < max(_PITCH_MIN_GAP_HZ, _PITCH_MIN_GAP_RATIO * median):
        return None
    # 间隙还要明显大于两档自身的起伏，否则只是同一人音高的自然波动。
    if gap < 1.2 * max(float(low.std()), float(high.std())):
        return None
    threshold = (low[-1] + high[0]) / 2
    labels = np.zeros(len(pitch), dtype=int)
    labels[pitch >= threshold] = 1
    return labels


def _load_pcm(path: str) -> np.ndarray:
    import av

    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        chunks = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def _sentence_feature(pcm: np.ndarray, start: int, end: int) -> np.ndarray:
    start = max(0, start)
    end = min(len(pcm), end)
    segment = pcm[start:end]
    frame_len = int(SAMPLE_RATE * FRAME_MS / 1000)
    hop = int(SAMPLE_RATE * HOP_MS / 1000)
    if len(segment) < frame_len:
        segment = np.pad(segment, (0, frame_len - len(segment)))
    frames = np.lib.stride_tricks.as_strided(
        segment,
        shape=(1 + (len(segment) - frame_len) // hop, frame_len),
        strides=(segment.strides[0] * hop, segment.strides[0]),
    ).copy()
    frames = frames - frames.mean(axis=1, keepdims=True)
    windows = np.hamming(frame_len)
    spec = np.abs(np.fft.rfft(frames * windows, n=N_FFT)) ** 2
    mel = spec @ _mel_filterbank().T
    log_mel = np.log(mel + 1e-10)
    mfcc = log_mel @ _dct_matrix().T
    pitch = _pitch_track(segment)
    if pitch.size == 0:
        pitch_stats = np.zeros(2)
    else:
        pitch_stats = np.array([np.median(pitch), np.std(pitch)])
    return np.concatenate([mfcc.mean(axis=0), mfcc.std(axis=0), pitch_stats])


def _pitch_track(segment: np.ndarray) -> np.ndarray:
    """自相关基频估计，用于区分音高不同的说话人（只保留高能量且清浊明显的帧）。"""
    frame_len = int(SAMPLE_RATE * 0.03)
    hop = int(SAMPLE_RATE * 0.01)
    if len(segment) < frame_len:
        return np.zeros(0)
    count = 1 + (len(segment) - frame_len) // hop
    frames = np.lib.stride_tricks.as_strided(
        segment, shape=(count, frame_len), strides=(segment.strides[0] * hop, segment.strides[0])
    ).copy()
    energy = np.sum(frames ** 2, axis=1)
    keep = frames[energy >= max(np.percentile(energy, 40), 1e-8)]
    if len(keep) == 0:
        return np.zeros(0)
    keep = keep - keep.mean(axis=1, keepdims=True)
    corr = np.fft.irfft(np.abs(np.fft.rfft(keep, n=2 * frame_len)) ** 2, axis=1)[:, :frame_len]
    corr = corr / (corr[:, :1] + 1e-9)
    low, high = int(SAMPLE_RATE / 400), int(SAMPLE_RATE / 60)
    peaks = []
    for row in corr[:, low:high]:
        idx = int(np.argmax(row))
        if row[idx] > 0.3:
            peaks.append(SAMPLE_RATE / (low + idx))
    return np.array(peaks)


def _mel_filterbank() -> np.ndarray:
    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    low, high = 50.0, SAMPLE_RATE / 2
    mel_points = np.linspace(hz_to_mel(low), hz_to_mel(high), N_MELS + 2)
    hz_points = mel_to_hz(mel_points)
    bins = np.floor((N_FFT + 1) * hz_points / SAMPLE_RATE).astype(int)
    fb = np.zeros((N_MELS, N_FFT // 2 + 1))
    for i in range(1, N_MELS + 1):
        left, center, right = bins[i - 1], bins[i], bins[i + 1]
        center = max(center, left + 1)
        right = max(right, center + 1)
        for j in range(left, min(center, fb.shape[1])):
            fb[i - 1, j] = (j - left) / (center - left)
        for j in range(center, min(right, fb.shape[1])):
            fb[i - 1, j] = (right - j) / (right - center)
    return fb


def _dct_matrix() -> np.ndarray:
    n = N_MELS
    k = N_MFCC
    matrix = np.zeros((k, n))
    for i in range(k):
        scale = np.sqrt(1.0 / n) if i == 0 else np.sqrt(2.0 / n)
        for j in range(n):
            matrix[i, j] = scale * np.cos(np.pi * i * (2 * j + 1) / (2 * n))
    return matrix


def _standardize(X: np.ndarray) -> np.ndarray:
    mean = X.mean(axis=0)
    std = X.std(axis=0) + 1e-6
    return (X - mean) / std


def _choose_k(X: np.ndarray) -> tuple[int, np.ndarray]:
    n = len(X)
    max_k = min(4, n // 2)
    if max_k <= 1:
        return 1, np.zeros(n, dtype=int)

    best = (0.0, 1, np.zeros(n, dtype=int))
    for k in range(2, max_k + 1):
        labels, _ = _kmeans(X, k)
        counts = np.bincount(labels, minlength=k)
        if counts.min() < max(2, n // 20):
            continue
        score = _silhouette(X, labels)
        if score > best[0]:
            best = (score, k, labels)
    # 轮廓系数太低说明分不开，按单说话人处理
    if best[0] < 0.18:
        return 1, np.zeros(n, dtype=int)
    return best[1], best[2]


def _kmeans(X: np.ndarray, k: int, iters: int = 30) -> tuple[np.ndarray, np.ndarray]:
    # 确定性初始化：第一个取首句，之后每次取离已选中心最远的点
    centers = [X[0]]
    for _ in range(1, k):
        dist = np.min([np.sum((X - c) ** 2, axis=1) for c in centers], axis=0)
        farthest = int(np.argmax(dist))
        centers.append(X[farthest])
    centers = np.vstack(centers)
    labels = np.zeros(len(X), dtype=int)
    for _ in range(iters):
        dist = ((X[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        new_labels = dist.argmin(axis=1)
        if np.array_equal(new_labels, labels) and _ > 0:
            break
        labels = new_labels
        for i in range(k):
            members = X[labels == i]
            if len(members):
                centers[i] = members.mean(axis=0)
    return labels, centers


def _silhouette(X: np.ndarray, labels: np.ndarray) -> float:
    n = len(X)
    if n > 1500:
        idx = np.linspace(0, n - 1, 1500).astype(int)
        X, labels = X[idx], labels[idx]
        n = 1500
    dist = np.sqrt(((X[:, None, :] - X[None, :, :]) ** 2).sum(axis=2))
    scores = []
    for i in range(n):
        own = labels == labels[i]
        own[i] = False
        if own.sum() == 0:
            continue
        a = dist[i, own].mean()
        b = min(
            dist[i, labels == other].mean()
            for other in set(labels)
            if other != labels[i] and (labels == other).sum() > 0
        )
        scores.append((b - a) / max(a, b, 1e-9))
    return float(np.mean(scores)) if scores else 0.0


def _label_names(labels: np.ndarray, k: int) -> dict[int, str]:
    first_seen = {}
    for i, label in enumerate(labels):
        first_seen.setdefault(int(label), i)
    ordered = sorted(first_seen, key=first_seen.get)
    return {label: f"Speaker {rank + 1}" for rank, label in enumerate(ordered)}
