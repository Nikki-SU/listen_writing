"""数据模型（骨架）。

存储是「人可读文本」：表格 / 行式 → CSV，嵌套结构 → JSON，正文稿 → Markdown。
这里的 dataclass 只是内存中的类型定义，落盘时再按各自载体序列化。
字段命名统一 snake_case（与前端约定一致，见 API_CONTRACT.md）。
"""

from dataclasses import dataclass

# 软件版本号：四段独立整数。提交时只 bump 对应段（见《工程纪律.md》第二板块）。
APP_VERSION = {
    "frontend": 18,
    "backend": 15,
    "model": 2,
    "data": 5,
}


@dataclass
class Identity:
    """人 = 昵称（唯一主体）；设备码是同人多设备的绑定凭据。权限绑 nick，不绑设备。"""

    nick: str
    device_code: str


@dataclass
class Project:
    """项目：研究容器，容纳多条录音。"""

    id: str
    name: str
    description: str = ""
    created_at: str = ""


@dataclass
class Recording:
    """录音：一次访谈 / 一个受访者。音频是唯一落目录的二进制。"""

    id: str
    project_id: str
    name: str
    audio_path: str
    format: str  # WAV / MP3 / M4A / WMA
    duration_sec: float = 0.0
    created_at: str = ""


@dataclass
class Sentence:
    """句：校对 / 合并的最小单元。start_ms / end_ms 供「点句跳音频」。"""

    id: str
    recording_id: str
    index: int
    text: str
    start_ms: int
    end_ms: int
    speaker: str = ""  # Speaker 1/2/... 或人工标注名


@dataclass
class VersionRef:
    """版本引用：版本号 = 阶段.阶段内序号 = (stage, seq)。每条录音一条版本线。"""

    recording_id: str
    stage: int  # 0 初始转写 / 1 文字润色 / 2 脱敏
    seq: int    # 阶段内序号，阶段升级时归 1
    parent: str = ""   # 上一个版本号 "stage.seq"，支撑「任意两版本可复刻」
    author_nick: str = ""
    timestamp: str = ""
    # diff：句子级变更集，落 JSON 文件，序列化时再展开。


@dataclass
class DesensitizationCategory:
    """脱敏类别：可增删、启用/停用，占位符默认 [类别名]。"""

    id: str
    name: str
    color: str
    enabled: bool = True
    placeholder: str = ""