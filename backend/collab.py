"""局域网协作：配对码群组、四级可自定义权限、材料快照、提案合并、只读播放审批、审查模式。

数据落盘在 `data/groups/<群组 id>/group.json`，仍遵守「人可读 JSON」的存储纪律。
所有写操作返回最新对象，由 main.py 负责 HTTP 编排；本模块只做数据与规则，不碰 HTTP。
"""

import json
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import storage

# 默认四级模板 + 审查者；能力可被群主逐项改写（PRD 12.4），所以存在群组里而不是硬编码。
DEFAULT_ROLES = {
    "owner": {
        "name": "群主",
        "caps": ["view", "edit", "submit", "merge", "material", "approve", "members", "roles", "review", "manage"],
    },
    "admin": {
        "name": "管理员",
        "caps": ["view", "edit", "submit", "merge", "material", "approve", "members", "review"],
    },
    "editor": {"name": "读写", "caps": ["view", "edit", "submit"]},
    "reader": {"name": "只读", "caps": ["view"]},
    "reviewer": {"name": "审查", "caps": ["view", "review"]},
}

VALID_ROLES = tuple(DEFAULT_ROLES.keys())
VALID_CAPS = (
    "view", "edit", "submit", "merge", "material", "approve", "members", "roles", "review", "manage",
)
PLAYBACK_MODES = ("burn", "permanent", "timed")


class CollabError(Exception):
    """带 HTTP 状态码的业务错误；main.py 直接转成 JSON。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _now() -> str:
    return storage.now_iso()


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


# ---------- 群组文件 ----------


def groups_root() -> Path:
    return storage.DATA_ROOT / "groups"


def group_dir(group_id: str) -> Path:
    return groups_root() / group_id


def group_path(group_id: str) -> Path:
    return group_dir(group_id) / "group.json"


def _write_json(path: Path, data: dict) -> None:
    # 复用 storage 的原子写：并发加成员 / 审批时不会读到半截 JSON。
    storage._write_json(path, data)


def load_group(group_id: str) -> dict:
    data = storage._read_json(group_path(group_id))
    if data is None:
        raise CollabError("群组不存在", status=404)
    return data


def try_load_group(group_id: str) -> dict | None:
    """跨机同步用：群组不存在时返回 None，而不是抛业务异常。"""
    return storage._read_json(group_path(group_id))


def import_group(group: dict) -> dict:
    """把从别的节点拿到的群组快照落到本机（加入跨机群组的落地步骤）。"""
    storage._write_json(group_path(group["id"]), group)
    return group


def _save(group: dict) -> dict:
    _write_json(group_path(group["id"]), group)
    return group


def _all_groups() -> list[dict]:
    root = groups_root()
    if not root.exists():
        return []
    out = []
    for d in root.iterdir():
        if d.is_dir():
            g = storage._read_json(d / "group.json")
            if g:
                out.append(g)
    out.sort(key=lambda g: g.get("created_at", ""), reverse=True)
    return out


def try_all_groups() -> list[dict]:
    return _all_groups()


def _unique_code() -> str:
    used = {g.get("code") for g in _all_groups()}
    for _ in range(50):
        code = f"{secrets.randbelow(900000) + 100000}"
        if code not in used:
            return code
    raise CollabError("配对码生成失败，请稍后重试", status=500)


# ---------- 身份与权限 ----------


def _local_identity() -> dict:
    return storage.get_settings()["identity"]


def _member(group: dict, device_code: str) -> dict | None:
    for m in group.get("members", []):
        if m.get("device_code") == device_code:
            return m
    return None


def _role(group: dict, member: dict) -> dict:
    roles = group.get("roles", {})
    return roles.get(member.get("role"), DEFAULT_ROLES["reader"])


def _caps(group: dict, member: dict) -> list[str]:
    return list(_role(group, member).get("caps") or [])


VALID_GRANT_CAPS = ("view", "edit", "submit", "material")


def _active_grants(group: dict, member: dict, material_id: str | None = None) -> list[dict]:
    """该成员当前有效的授权（长期角色之外的「单次 / 单材料」）。

    过期、撤销、次数用完的一律不返回；material_id 给定时只返回覆盖该材料的授权。
    """
    now = _now_dt()
    out = []
    for grant in group.get("grants", []):
        if grant.get("revoked") or grant.get("device_code") != member.get("device_code"):
            continue
        if grant.get("expires_at"):
            try:
                if now > datetime.fromisoformat(grant["expires_at"]):
                    continue
            except ValueError:
                continue
        limit = grant.get("uses")
        if limit is not None and int(grant.get("used", 0)) >= int(limit):
            continue
        scope = grant.get("scope") or "group"
        if scope == "material":
            materials = grant.get("material_ids") or []
            if material_id is not None and material_id not in materials:
                continue
            if material_id is None:
                continue
        out.append(grant)
    return out


def _grant_caps(group: dict, member: dict, material_id: str | None = None) -> list[str]:
    caps: list[str] = []
    for grant in _active_grants(group, member, material_id):
        caps.extend(grant.get("caps") or [])
    return caps


def _can(group: dict, member: dict, cap: str, material_id: str | None = None) -> bool:
    if cap in _caps(group, member):
        return True
    return cap in _grant_caps(group, member, material_id)


def _grant_for(group: dict, member: dict, cap: str, material_id: str | None) -> dict | None:
    """找出让这次操作成立的授权；单次授权在这里消耗一次。"""
    if cap in _caps(group, member):
        return None
    for grant in _active_grants(group, member, material_id):
        if cap not in (grant.get("caps") or []):
            continue
        if grant.get("uses") is not None:
            grant["used"] = int(grant.get("used", 0)) + 1
            if grant["used"] >= int(grant["uses"]):
                grant["exhausted_at"] = _now()
        return grant
    return None


def _require(group: dict, device_code: str, cap: str, material_id: str | None = None, consume: bool = True) -> dict:
    member = _member(group, device_code)
    if member is None:
        raise CollabError("你还没有加入这个群组", status=403)
    if not _can(group, member, cap, material_id):
        raise CollabError(f"当前权限（{_role(group, member).get('name')}）不允许此操作", status=403)
    # 单次授权必须在业务校验全部通过后才消耗；否则一次失败请求会把授权烧掉。
    if consume:
        _grant_for(group, member, cap, material_id)
    return member


def _is_reviewer(group: dict, member: dict) -> bool:
    return "review" in _caps(group, member) and "edit" not in _caps(group, member)


def _log(group: dict, member: dict | None, action: str, material_id: str = "", detail: str = "", dedupe_sec: float = 0) -> None:
    logs = group.setdefault("access", [])
    device = (member or {}).get("device_code", "")
    if dedupe_sec and logs:
        last = logs[-1]
        # <audio> 播放会连续发多个 Range 请求；同一材料 60 秒内只记一条，避免日志被刷屏。
        if (
            last.get("action") == action
            and last.get("material_id") == material_id
            and last.get("device_code") == device
            and time.time() - float(last.get("ts") or 0) < dedupe_sec
        ):
            return
    logs.append({
        "id": storage.new_id(),
        "at": _now(),
        "ts": time.time(),
        "device_code": device,
        "nick": (member or {}).get("nick", ""),
        "action": action,
        "material_id": material_id,
        "detail": detail,
    })
    del logs[:-500]  # 只留最近 500 条，避免群组文件无限增长


def _version_next(version: str) -> str:
    stage, _, seq = version.partition(".")
    try:
        return f"{int(stage)}.{int(seq) + 1}"
    except ValueError:
        return f"{stage}.1"


def _bump_revision(material: dict) -> None:
    """材料内容每变一次就生成新修订号，并并入已知集合。

    跨机同步用修订集合判断祖先关系：版本号会碰撞（两端各自 +1 后仍是同一个号），
    修订号不会，所以「对方是否包含我当前修订」才是可靠的快进依据。
    """
    old = material.get("rev") or ""
    revs = list(material.get("revs") or [])
    if old and old not in revs:
        revs.append(old)
    new = storage.new_id()
    revs.append(new)
    material["rev"] = new
    material["revs"] = revs[-200:]


# ---------- 群组 CRUD ----------


def create_group(name: str, mode: str, device_code: str, nick: str, code_days: int = 30) -> dict:
    name = name.strip()
    if not name:
        raise CollabError("群组名称不能为空")
    if mode not in ("authoritative", "replica"):
        raise CollabError("mode 只能是 authoritative 或 replica")
    try:
        code_days = int(code_days or 30)
    except (TypeError, ValueError):
        raise CollabError("配对码有效天数必须是整数")
    if code_days < 1 or code_days > 365:
        raise CollabError("配对码有效天数需在 1–365 之间")
    now = _now()
    group = {
        "id": storage.new_id(),
        "name": name,
        "code": _unique_code(),
        "code_days": code_days,
        # 配对码默认 30 天有效；过期后拒绝新成员加入，群主可重新生成。
        "code_expires_at": (_now_dt() + timedelta(days=code_days)).isoformat(),
        "mode": mode,  # authoritative=无副本（群主权威）；replica=有副本（节点合并）
        "created_at": now,
        "owner_device": device_code,
        "roles": json.loads(json.dumps(DEFAULT_ROLES)),  # 深拷贝，群内改权限不污染默认模板
        "members": [{
            "device_code": device_code,
            "nick": nick,
            "role": "owner",
            "joined_at": now,
        }],
        "member_requests": [],
        "materials": [],
        "proposals": [],
        "approvals": [],
        "grants": [],
        "access": [],
    }
    _save(group)
    _log(group, _member(group, device_code), "create_group", detail=name)
    _save(group)
    return group


def list_groups(device_code: str, nick: str) -> list[dict]:
    """列出本机参与的全部群组；未加入的群组（理论上不存在）不暴露。"""
    out = []
    for g in _all_groups():
        member = _member(g, device_code)
        if member is None:
            continue
        out.append({**_summary(g), "my_role": member.get("role"), "my_role_name": _role(g, member).get("name")})
    return out


def get_group(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    member = _require(group, device_code, "view")
    return {**_summary(group), "my_role": member.get("role"), "roles": group.get("roles", {})}


def _summary(group: dict) -> dict:
    materials = group.get("materials", [])
    return {
        "id": group.get("id"),
        "name": group.get("name"),
        "code": group.get("code"),
        "code_expires_at": group.get("code_expires_at"),
        "mode": group.get("mode"),
        "created_at": group.get("created_at"),
        "owner_device": group.get("owner_device"),
        "member_count": len(group.get("members", [])),
        "material_count": len(materials),
        "pending_proposals": len([p for p in group.get("proposals", []) if p.get("status") in ("pending", "conflict")]),
        "pending_playbacks": len([a for a in group.get("approvals", []) if a.get("status") == "pending"]),
        "pending_requests": len([r for r in group.get("member_requests", []) if r.get("status") == "pending"]),
    }


def delete_group(group_id: str, device_code: str) -> None:
    group = load_group(group_id)
    if group.get("owner_device") != device_code:
        raise CollabError("只有群主可以解散群组", status=403)
    import shutil

    shutil.rmtree(group_dir(group_id), ignore_errors=True)


def code_expired(group: dict) -> bool:
    expiry = group.get("code_expires_at")
    if not expiry:
        return False
    try:
        return _now_dt() > datetime.fromisoformat(expiry)
    except (TypeError, ValueError):
        return False


def join_group(code: str, device_code: str, nick: str, role: str) -> dict:
    code = code.strip()
    group = next((g for g in _all_groups() if g.get("code") == code), None)
    if group is None:
        raise CollabError("配对码不存在或已失效", status=404)
    if code_expired(group):
        raise CollabError("配对码已过期，请让群主重新生成", status=410)
    if role == "owner" or role == "admin":
        raise CollabError("加入时只能是只读或审查者，管理员需群主任命", status=400)
    if role not in ("reader", "reviewer"):
        raise CollabError("role 只能是 reader 或 reviewer")
    member = _member(group, device_code)
    now = _now()
    if member is None:
        member = {"device_code": device_code, "nick": nick, "role": role, "joined_at": now}
        group.setdefault("members", []).append(member)
        _log(group, member, "join_group", detail=f"以 {role} 加入")
    else:
        member["nick"] = nick or member.get("nick")
        _log(group, member, "rejoin_group")
    _save(group)
    return {**_summary(group), "my_role": member.get("role"), "roles": group.get("roles", {})}


def members(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    _require(group, device_code, "view")
    return {
        "members": group.get("members", []),
        "roles": group.get("roles", {}),
        "member_requests": group.get("member_requests", []),
        "owner_device": group.get("owner_device"),
    }


def update_member(group_id: str, target: str, role: str, device_code: str, nick: str = "") -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "members")
    if role not in VALID_ROLES:
        raise CollabError("未知角色")
    if role == "owner":
        raise CollabError("群主转让尚未开放", status=400)
    target_member = _member(group, target)
    if target_member is None:
        raise CollabError("成员不存在", status=404)
    if target_member.get("role") == "owner":
        raise CollabError("不能修改群主", status=403)
    actor_role = actor.get("role")
    if actor_role == "admin":
        if target_member.get("role") == "admin":
            raise CollabError("管理员不能直接调整另一位管理员，需群主通过", status=403)
        if role == "admin":
            req = {
                "id": storage.new_id(),
                "device_code": target,
                "nick": target_member.get("nick", ""),
                "role": "admin",
                "by": actor.get("device_code"),
                "by_nick": actor.get("nick", ""),
                "at": _now(),
                "status": "pending",
            }
            group.setdefault("member_requests", []).append(req)
            _save(group)
            return {"pending": req, "member_requests": group["member_requests"]}
    target_member["role"] = role
    target_member["updated_at"] = _now()
    if nick:
        target_member["nick"] = nick
    _log(group, actor, "update_member", detail=f"{target_member.get('nick')} → {role}")
    _save(group)
    return {"member": target_member, "members": group.get("members", [])}


def decide_member_request(group_id: str, request_id: str, approve: bool, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "roles")  # 只有群主默认具备 roles
    req = next((r for r in group.get("member_requests", []) if r.get("id") == request_id), None)
    if req is None:
        raise CollabError("申请不存在", status=404)
    if req.get("status") != "pending":
        raise CollabError("该申请已经处理过", status=409)
    if approve:
        member = _member(group, req["device_code"])
        if member is not None:
            member["role"] = req["role"]
        req["status"] = "approved"
    else:
        req["status"] = "rejected"
    req["decided_by"] = actor.get("device_code")
    req["decided_at"] = _now()
    _log(group, actor, "decide_member_request", detail=f"{req.get('nick')} → {'通过' if approve else '拒绝'}")
    _save(group)
    return {"request": req, "members": group.get("members", [])}


def remove_member(group_id: str, target: str, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "members")
    target_member = _member(group, target)
    if target_member is None:
        raise CollabError("成员不存在", status=404)
    if target_member.get("role") == "owner":
        raise CollabError("不能移除群主", status=403)
    if actor.get("role") == "admin" and target_member.get("role") == "admin":
        raise CollabError("管理员不能移除另一位管理员", status=403)
    group["members"] = [m for m in group.get("members", []) if m.get("device_code") != target]
    _log(group, actor, "remove_member", detail=target_member.get("nick", ""))
    _save(group)
    return {"members": group.get("members", [])}


def update_roles(group_id: str, role: str, caps: list[str], name: str, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "roles")
    if role not in VALID_ROLES:
        raise CollabError("未知角色")
    if not isinstance(caps, list) or not all(isinstance(c, str) and c in VALID_CAPS for c in caps):
        raise CollabError("caps 含未知能力")
    if role == "owner":
        # 群主必须保留权限管理，否则群组会失去控制入口。
        if "roles" not in caps or "manage" not in caps:
            raise CollabError("群主权限必须保留 roles 与 manage", status=400)
    current = group.get("roles", {}).get(role, {})
    group.setdefault("roles", {})[role] = {
        "name": (name or current.get("name") or DEFAULT_ROLES[role]["name"]).strip(),
        "caps": caps,
        "updated_at": _now(),
    }
    _log(group, actor, "update_roles", detail=f"{role}: {', '.join(caps)}")
    _save(group)
    return {"roles": group["roles"]}


# ---------- 材料 ----------


def add_material(group_id: str, project_id: str, recording_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "material")
    recording = storage.get_recording(project_id, recording_id)
    if recording is None:
        raise CollabError("录音不存在", status=404)
    sentences = storage.load_sentences(project_id, recording_id)
    if not sentences:
        raise CollabError("该录音还没有转写内容", status=409)
    current = storage.ensure_current_version(project_id, recording_id) or {"current": "0.0", "stage": 0}
    version = str(current.get("current") or "0.0")
    redactions = storage.get_redactions(project_id, recording_id)
    existing = next(
        (m for m in group.get("materials", [])
         if m.get("project_id") == project_id and m.get("recording_id") == recording_id),
        None,
    )
    if existing is not None:
        # 同一录音再次灌入时刷新既有材料，而不是堆出多个同名副本。
        before_map = {str(s.get("id")): s.get("text", "") for s in existing.get("sentences", [])}
        diff = []
        for s in sentences:
            old = before_map.get(str(s.get("id")), "")
            if old != s.get("text", ""):
                diff.append({
                    "sentence_id": s.get("id", ""),
                    "index": int(s.get("index", 0)),
                    "before": old,
                    "after": s.get("text", ""),
                })
        existing.update({
            "name": recording.get("name", existing.get("name", "")),
            "stage": int(current.get("stage", 0)),
            "version": version,
            "sentences": sentences,
            "base_sentences": sentences,
            "redactions": redactions,
            "audio_path": recording.get("audio_path", ""),
            "format": recording.get("format", ""),
            "updated_at": _now(),
            # 重新灌入后偏移已按新文本重算，陈旧标记可以清除。
            "stale_redactions": False,
        })
        _bump_revision(existing)
        _snapshot_history(existing, "刷新为当前版本", actor.get("nick", ""), diff)
        _log(group, actor, "refresh_material", existing["id"], existing.get("name", ""))
        _save(group)
        return _material_meta(group, existing, actor)
    rev = storage.new_id()
    material = {
        "id": storage.new_id(),
        "name": recording.get("name", ""),
        "project_id": project_id,
        "recording_id": recording_id,
        "stage": int(current.get("stage", 0)),
        "version": version,
        "rev": rev,
        "revs": [rev],
        "sentences": sentences,
        # 三方合并的基线：最后一次灌入 / 合并时的快照
        "base_sentences": sentences,
        "redactions": redactions,
        "audio_path": recording.get("audio_path", ""),
        "format": recording.get("format", ""),
        "added_at": _now(),
        "updated_at": _now(),
        "added_by": actor.get("nick", ""),
        "source_device": actor.get("device_code", ""),
        "history": [],
    }
    _snapshot_history(material, "灌入当前版本", actor.get("nick", ""), [])
    group.setdefault("materials", []).append(material)
    _log(group, actor, "add_material", material["id"], material["name"])
    _save(group)
    return _material_meta(group, material, actor)


def _material_meta(group: dict, material: dict, member: dict) -> dict:
    return {
        "id": material.get("id"),
        "name": material.get("name"),
        "stage": material.get("stage", 0),
        "version": material.get("version"),
        "sentence_count": len(material.get("sentences", [])),
        "added_at": material.get("added_at"),
        "added_by": material.get("added_by"),
        "can_play": _playback_state(group, material, member)[0],
    }


def _restricted(group: dict, member: dict, material_id: str | None = None) -> bool:
    """只读 / 审查者（以及没有编辑类授权的成员）只能看到脱敏后的阶段 2 内容。"""
    caps = _caps(group, member)
    if "edit" in caps or "merge" in caps:
        return False
    if material_id is not None:
        grant_caps = _grant_caps(group, member, material_id)
        if "edit" in grant_caps or "merge" in grant_caps:
            return False
    return True


def can_edit(group: dict, device_code: str) -> bool:
    """本机身份在这个群组里是否有编辑权；副本节点据此决定要不要拉原始媒体。"""
    member = _member(group, device_code)
    return member is not None and not _restricted(group, member)


def _apply_marks(sentences: list[dict], marks: list[dict]) -> list[dict]:
    """把脱敏标记替换为占位符（与 main._apply_redactions 同规则，避免循环导入）。"""
    grouped: dict[str, list[dict]] = {}
    for m in marks:
        grouped.setdefault(m.get("sentence_id", ""), []).append(m)
    out = []
    for s in sentences:
        text = str(s.get("text", ""))
        for m in sorted(grouped.get(s.get("id", ""), []), key=lambda x: x.get("start", 0), reverse=True):
            start, end = int(m.get("start", 0)), int(m.get("end", 0))
            if 0 <= start < end <= len(text):
                text = text[:start] + str(m.get("placeholder") or "[已脱敏]") + text[end:]
        out.append({**s, "text": text})
    return out


def _safe_redactions(marks: list[dict]) -> list[dict]:
    return [{k: v for k, v in m.items() if k not in ("original", "text")} for m in marks]


def _sanitized_material(material: dict, member: dict) -> dict:
    """给只读 / 审查者的材料快照：不包含原始句子、音频路径、项目坐标与提案。"""
    sentences = _apply_marks(material.get("sentences", []), material.get("redactions", []))
    history = [
        {k: v for k, v in h.items() if k not in ("sentences", "diff")}
        for h in material.get("history", [])
        if int(h.get("stage", 0)) >= 2
    ]
    return {
        "id": material.get("id"),
        "name": material.get("name"),
        "stage": material.get("stage", 0),
        "version": material.get("version"),
        "rev": material.get("rev"),
        "revs": material.get("revs") or [],
        "sentences": sentences,
        # 三方合并基线也不能泄露原文：用脱敏后的句子作为基线。
        "base_sentences": sentences,
        "redactions": _safe_redactions(material.get("redactions", [])),
        "stale_redactions": bool(material.get("stale_redactions")),
        "format": material.get("format", ""),
        "added_at": material.get("added_at"),
        "updated_at": material.get("updated_at"),
        "added_by": material.get("added_by"),
        "history": history,
    }


def sanitized_group(group: dict, device_code: str) -> dict:
    """按请求者身份返回群组快照。

    有编辑权的成员拿完整数据；只读 / 审查者只拿阶段 2 之后、已脱敏的内容，
    并且不包含提案、授权、访问日志与任何媒体坐标。非成员的预览连材料都不返回。
    """
    member = _member(group, device_code)
    if member is None:
        return {
            **_summary(group),
            "roles": group.get("roles", {}),
            "members": group.get("members", []),
            "materials": [],
            "proposals": [],
            "approvals": [],
            "grants": [],
            "access": [],
            "member_requests": [],
        }
    if not _restricted(group, member):
        return group
    out = json.loads(json.dumps(group))
    local_member = _member(out, device_code)
    out["materials"] = [_sanitized_material(m, local_member) for m in _visible(out, local_member)]
    out["proposals"] = []
    out["grants"] = [g for g in out.get("grants", []) if g.get("device_code") == device_code]
    out["approvals"] = [a for a in out.get("approvals", []) if a.get("device_code") == device_code]
    out["access"] = []
    out["member_requests"] = []
    return out


def _visible(group: dict, member: dict) -> list[dict]:
    materials = group.get("materials", [])
    if "view" not in _caps(group, member):
        # 没有长期 view 权限时，只能看到被单材料授权覆盖的材料。
        materials = [m for m in materials if _can(group, member, "view", m.get("id"))]
    if _restricted(group, member):
        # 审查 / 只读可见范围从阶段 2 之后开始（PRD 13）；拿到编辑类单材料授权的除外。
        materials = [
            m for m in materials
            if int(m.get("stage", 0)) >= 2 or not _restricted(group, member, m.get("id"))
        ]
    return materials


def list_materials(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    member = _member(group, device_code)
    if member is None:
        raise CollabError("你还没有加入这个群组", status=403)
    if "view" not in _caps(group, member) and not _active_grants(group, member):
        raise CollabError("当前权限不允许查看材料", status=403)
    return {"materials": [_material_meta(group, m, member) for m in _visible(group, member)]}


def get_material(group_id: str, material_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    member = _require(group, device_code, "view", material_id)
    material = next((m for m in _visible(group, member) if m.get("id") == material_id), None)
    if material is None:
        if _is_reviewer(group, member):
            raise CollabError("审查模式仅可查看阶段 2 之后的版本", status=403)
        raise CollabError("材料不存在", status=404)

    restricted = _restricted(group, member, material_id)
    if restricted:
        # 审查者 / 只读成员只看脱敏后的正文，历史截断到阶段 2，且不暴露任何原文。
        sentences = _apply_marks(material.get("sentences", []), material.get("redactions", []))
        history = [
            {k: v for k, v in h.items() if k not in ("sentences", "diff")}
            for h in material.get("history", [])
            if int(h.get("stage", 0)) >= 2
        ]
        redactions = _safe_redactions(material.get("redactions", []))
    else:
        sentences = material.get("sentences", [])
        history = material.get("history", [])
        redactions = material.get("redactions", [])

    playback, approval = _playback_state(group, material, member)
    _log(group, member, "view_material", material_id, "审查模式" if _is_reviewer(group, member) else "")
    _save(group)
    return {
        "material": {
            **_material_meta(group, material, member),
            "sentences": sentences,
            "history": history,
            "redactions": redactions,
            "stale_redactions": bool(material.get("stale_redactions")),
        },
        "can_play": playback,
        "approval": approval,
        "review_mode": _is_reviewer(group, member),
    }


def get_material_version(group_id: str, material_id: str, version: str, device_code: str) -> dict:
    """群组材料的任意历史版本：自带句子快照与 diff，审查端按权限脱敏。"""
    group = load_group(group_id)
    member = _require(group, device_code, "view", material_id, consume=False)
    material = next((m for m in group.get("materials", []) if m.get("id") == material_id), None)
    if material is None:
        raise CollabError("材料不存在", status=404)
    entry = next(
        (h for h in material.get("history", []) if str(h.get("version")) == str(version)),
        None,
    )
    if entry is None:
        raise CollabError("版本不存在", status=404)
    if _restricted(group, member, material_id):
        if int(entry.get("stage", 0)) < 2:
            raise CollabError("审查模式仅可查看阶段 2 之后的版本", status=403)
        entry = {
            **{k: v for k, v in entry.items() if k not in ("sentences", "diff")},
            "sentences": _apply_marks(material.get("sentences", []), material.get("redactions", [])),
            "diff": [],
        }
    return {"version": entry}


# ---------- 提案（PR 式逐条合并） ----------


def create_proposal(group_id: str, material_id: str, sentence_id: str, after: str, device_code: str) -> dict:
    group = load_group(group_id)
    # 先不消耗单次授权：等句子、内容都校验通过后再消耗，避免失败请求烧掉授权。
    actor = _require(group, device_code, "submit", material_id, consume=False)
    material = next((m for m in group.get("materials", []) if m.get("id") == material_id), None)
    if material is None:
        raise CollabError("材料不存在", status=404)
    target = next((s for s in material.get("sentences", []) if s.get("id") == sentence_id), None)
    if target is None:
        raise CollabError("句子不存在", status=404)
    after = after.strip()
    if not after:
        raise CollabError("修改后的句子不能为空")
    if after == target.get("text"):
        raise CollabError("内容没有变化", status=409)
    _grant_for(group, actor, "submit", material_id)
    proposal = {
        "id": storage.new_id(),
        "material_id": material_id,
        "sentence_id": sentence_id,
        "index": int(target.get("index", 0)),
        "before": target.get("text", ""),
        "after": after,
        "by_device": actor.get("device_code"),
        "by": actor.get("nick", ""),
        "created_at": _now(),
        "status": "pending",
    }
    group.setdefault("proposals", []).append(proposal)
    _log(group, actor, "create_proposal", material_id, f"第 {proposal['index'] + 1} 句")
    _save(group)
    return proposal


def list_proposals(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    member = _member(group, device_code)
    if member is None:
        raise CollabError("你还没有加入这个群组", status=403)
    # 提案里带 before/after 原文，只读 / 审查者一律不可见（PRD 13）。
    if not (
        "submit" in _caps(group, member)
        or "merge" in _caps(group, member)
        or {"submit", "merge"} & set(_grant_caps(group, member))
    ):
        raise CollabError("当前权限不可查看修改提案", status=403)
    visible = {
        m.get("id") for m in group.get("materials", [])
        if _can(group, member, "submit", m.get("id")) or _can(group, member, "merge", m.get("id"))
    }
    return {
        "proposals": [
            p for p in group.get("proposals", [])
            if p.get("material_id") in visible
        ]
    }


def _drop_stale_marks(material: dict, sentence_id: str) -> None:
    """句子正文变了，旧的脱敏偏移就失效；删掉该句标记并让审查者看到占位提示。"""
    marks = material.get("redactions", [])
    kept = [m for m in marks if m.get("sentence_id") != sentence_id]
    if len(kept) != len(marks):
        material["redactions"] = kept
        material["stale_redactions"] = True


def _snapshot_history(material: dict, message: str, by: str, diff: list[dict]) -> dict:
    """群组历史必须自带句子快照与 diff，否则跨机 / 审查端无法复刻任意版本。"""
    entry = {
        "version": material.get("version"),
        "stage": int(material.get("stage", 0)),
        "at": _now(),
        "by": by,
        "message": message,
        "sentences": json.loads(json.dumps(material.get("sentences", []))),
        "diff": diff,
    }
    material.setdefault("history", []).append(entry)
    return entry


def _writeback(material: dict, message: str, diff: list[dict]) -> None:
    """群组里的显式合并要写回本机项目，否则本地版本与群组版本会长期分叉。"""
    project_id = material.get("project_id")
    recording_id = material.get("recording_id")
    if not project_id or not recording_id:
        return
    if storage.get_recording(project_id, recording_id) is None:
        return
    try:
        sentences = json.loads(json.dumps(material.get("sentences", [])))
        storage.save_sentences(project_id, recording_id, sentences)
        from main import _sentences_to_markdown  # 延迟导入，避免循环依赖

        storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(sentences))
        stage = int(str(material.get("version", "0.0")).partition(".")[0] or 0)
        storage.commit_version(
            project_id,
            recording_id,
            sentences,
            diff,
            message,
            storage.get_settings()["identity"]["nick"],
            advance_to=stage,
            redactions=material.get("redactions", []),
        )
    except Exception:
        # 写回失败不能影响群组合并本身：补同步会在下次打开材料时重试。
        pass


def decide_proposal(group_id: str, proposal_id: str, accept: bool, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "merge")
    proposal = next((p for p in group.get("proposals", []) if p.get("id") == proposal_id), None)
    if proposal is None:
        raise CollabError("提案不存在", status=404)
    if proposal.get("status") not in ("pending", "conflict"):
        raise CollabError("该提案已经处理过", status=409)
    material = next((m for m in group.get("materials", []) if m.get("id") == proposal.get("material_id")), None)
    if material is None:
        raise CollabError("材料不存在", status=404)
    target = next((s for s in material.get("sentences", []) if s.get("id") == proposal.get("sentence_id")), None)
    if target is None:
        raise CollabError("句子已不存在", status=409)
    if not accept:
        proposal.update({"status": "rejected", "decided_by": actor.get("nick", ""), "decided_at": _now()})
        _log(group, actor, "reject_proposal", material["id"], f"第 {proposal['index'] + 1} 句")
        _save(group)
        return {"proposal": proposal, "material": _material_meta(group, material, actor)}
    # 不同句子的提案天然可并行合并；同一句被改两次时才需要人工判断。
    if target.get("text") != proposal.get("before") and proposal.get("status") == "pending":
        proposal["status"] = "conflict"
        proposal["conflict_text"] = target.get("text", "")
        _save(group)
        raise CollabError("该句已被其他改动覆盖，请确认后再强制合并", status=409)
    before = target.get("text", "")
    _drop_stale_marks(material, target.get("id", ""))
    target["text"] = proposal.get("after", "")
    material["version"] = _version_next(material.get("version", "2.0"))
    material["updated_at"] = _now()
    _bump_revision(material)
    message = f"合并第 {proposal['index'] + 1} 句（{proposal.get('by', '')} 提交）"
    diff = [{
        "sentence_id": target.get("id", ""),
        "index": int(target.get("index", 0)),
        "before": before,
        "after": target.get("text", ""),
    }]
    _snapshot_history(material, message, actor.get("nick", ""), diff)
    _writeback(material, message, diff)
    proposal.update({
        "status": "accepted",
        "decided_by": actor.get("nick", ""),
        "decided_at": _now(),
        "conflict_text": "",
    })
    _log(group, actor, "merge_proposal", material["id"], f"第 {proposal['index'] + 1} 句")
    _save(group)
    return {"proposal": proposal, "material": _material_meta(group, material, actor)}


def merge_snapshot(group_id: str, material_id: str, parent: str, sentences: list[dict], device_code: str, force: bool = False) -> dict:
    """有副本模式下的节点合并：以 base 做三方合并，能自动合的就合，冲突列出来人工判断。"""
    group = load_group(group_id)
    actor = _require(group, device_code, "merge")
    material = next((m for m in group.get("materials", []) if m.get("id") == material_id), None)
    if material is None:
        raise CollabError("材料不存在", status=404)
    if parent != material.get("version"):
        # 允许落后一个版本：仍按 sentence 级三方合并处理，不直接拒绝。
        pass
    incoming = {str(s.get("id")): s for s in sentences if isinstance(s, dict)}
    current = {str(s.get("id")): s for s in material.get("sentences", [])}
    base = {str(s.get("id")): s for s in material.get("base_sentences", [])}

    merged = dict(current)
    conflicts = []
    for sid, inc in incoming.items():
        cur = current.get(sid)
        if cur is None or sid not in base:
            merged[sid] = inc
            continue
        old = base[sid].get("text", "")
        cur_text = cur.get("text", "")
        inc_text = inc.get("text", "")
        if inc_text == cur_text:
            continue
        if cur_text == old:
            merged[sid] = {**cur, "text": inc_text, "speaker": inc.get("speaker", cur.get("speaker", ""))}
        elif inc_text == old:
            continue
        else:
            conflicts.append({
                "sentence_id": sid,
                "index": int(cur.get("index", 0)),
                "base": old,
                "current": cur_text,
                "incoming": inc_text,
            })
    if conflicts:
        if not force:
            return {"status": "conflict", "conflicts": conflicts, "material": _material_meta(group, material, actor)}
        # 强制合并：冲突句一律采用本地节点的版本。
        for c in conflicts:
            sid = c["sentence_id"]
            cur = current.get(sid, {})
            inc = incoming.get(sid, {})
            merged[sid] = {**cur, "text": inc.get("text", cur.get("text", "")), "speaker": inc.get("speaker", cur.get("speaker", ""))}

    ordered = sorted(merged.values(), key=lambda s: int(s.get("index", 0)))
    before_map = {str(s.get("id")): s.get("text", "") for s in material.get("sentences", [])}
    diff = []
    for s in ordered:
        old = before_map.get(str(s.get("id")), "")
        if old != s.get("text", ""):
            diff.append({
                "sentence_id": s.get("id", ""),
                "index": int(s.get("index", 0)),
                "before": old,
                "after": s.get("text", ""),
            })
            _drop_stale_marks(material, str(s.get("id")))
    material["sentences"] = ordered
    material["base_sentences"] = ordered
    material["version"] = _version_next(material.get("version", "2.0"))
    material["updated_at"] = _now()
    _bump_revision(material)
    message = "节点合并（三方自动合并）" if not conflicts else "节点合并（冲突句强制采用本地版本）"
    _snapshot_history(material, message, actor.get("nick", ""), diff)
    _writeback(material, message, diff)
    _log(group, actor, "merge_snapshot", material_id, material["version"])
    _save(group)
    return {"status": "merged", "material": _material_meta(group, material, actor), "version": material["version"]}


# ---------- 只读播放审批 ----------


def _find_approval(group: dict, approval_id: str) -> dict | None:
    return next((a for a in group.get("approvals", []) if a.get("id") == approval_id), None)


def _approval_usable(group: dict, approval: dict) -> bool:
    if approval.get("status") == "used":
        return False
    if approval.get("mode") == "burn" and approval.get("used_at"):
        return False
    if approval.get("mode") == "timed":
        expiry = approval.get("expires_at")
        if expiry:
            try:
                if _now_dt() > datetime.fromisoformat(expiry):
                    return False
            except ValueError:
                return False
    return approval.get("status") == "approved"


def _playback_state(group: dict, material: dict, member: dict) -> tuple[bool, dict | None]:
    """返回该成员对本材料的播放资格与最近一次审批。"""
    if "view" not in _caps(group, member) and not _can(group, member, "view", material.get("id")):
        return False, None
    mine = [
        a for a in group.get("approvals", [])
        if a.get("material_id") == material.get("id") and a.get("device_code") == member.get("device_code")
    ]
    for approval in reversed(mine):
        if _approval_usable(group, approval):
            return True, approval
    return False, (mine[-1] if mine else None)


def request_playback(group_id: str, material_id: str, mode: str, days: int, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "view", material_id)
    if mode not in PLAYBACK_MODES:
        raise CollabError("批准模式只能是 burn / permanent / timed")
    material = next((m for m in group.get("materials", []) if m.get("id") == material_id), None)
    if material is None:
        raise CollabError("材料不存在", status=404)
    if _is_reviewer(group, actor) and int(material.get("stage", 0)) < 2:
        raise CollabError("审查模式仅可查看阶段 2 之后的版本", status=403)
    if not str(material.get("audio_path") or ""):
        raise CollabError("该材料没有可播放音频", status=409)
    pending = next(
        (a for a in group.get("approvals", [])
         if a.get("material_id") == material_id and a.get("device_code") == device_code and a.get("status") == "pending"),
        None,
    )
    if pending is not None:
        raise CollabError("已有待审批的播放申请", status=409)
    try:
        days = int(days or 7)
    except (TypeError, ValueError):
        raise CollabError("days 必须是整数")
    if days < 1 or days > 365:
        raise CollabError("有效天数需在 1–365 之间")
    approval = {
        "id": storage.new_id(),
        "material_id": material_id,
        "device_code": device_code,
        "nick": actor.get("nick", ""),
        "mode": mode,
        "days": days,
        "status": "pending",
        "requested_at": _now(),
    }
    group.setdefault("approvals", []).append(approval)
    _log(group, actor, "request_playback", material_id, mode)
    _save(group)
    return approval


def list_approvals(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    member = _require(group, device_code, "view")
    mine = "approve" not in _caps(group, member)
    approvals = group.get("approvals", [])
    if mine:
        approvals = [a for a in approvals if a.get("device_code") == device_code]
    return {"approvals": approvals}


def decide_playback(group_id: str, approval_id: str, approve: bool, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "approve")
    approval = _find_approval(group, approval_id)
    if approval is None:
        raise CollabError("审批不存在", status=404)
    if approval.get("status") != "pending":
        raise CollabError("该审批已经处理过", status=409)
    now = _now()
    if approve:
        approval["status"] = "approved"
        approval["granted_by"] = actor.get("nick", "")
        approval["granted_at"] = now
        if approval.get("mode") == "timed":
            approval["expires_at"] = (_now_dt() + timedelta(days=int(approval.get("days") or 7))).isoformat()
    else:
        approval["status"] = "denied"
        approval["decided_at"] = now
    _log(group, actor, "decide_playback", approval.get("material_id"), f"{approval.get('mode')} → {'批准' if approve else '拒绝'}")
    _save(group)
    return approval


def playback_target(group_id: str, material_id: str, approval_id: str, device_code: str) -> tuple[Path, str, dict]:
    group = load_group(group_id)
    approval = _find_approval(group, approval_id)
    if approval is None or approval.get("material_id") != material_id:
        raise CollabError("播放审批不存在", status=404)
    if approval.get("device_code") != device_code:
        raise CollabError("这条审批不属于当前设备", status=403)
    if not _approval_usable(group, approval):
        raise CollabError("播放授权已失效（已用完或已过期）", status=403)
    material = next((m for m in group.get("materials", []) if m.get("id") == material_id), None)
    if material is None:
        raise CollabError("材料不存在", status=404)
    path = Path(material.get("audio_path") or "")
    if not path.is_file():
        # 副本节点的材料坐标可能来自别的机器，或本地项目已移动音乐文件；回退到本机录音路径。
        recording = storage.get_recording(material.get("project_id") or "", material.get("recording_id") or "")
        if recording and recording.get("audio_path"):
            path = Path(recording["audio_path"])
            if path.is_file():
                material["audio_path"] = str(path)
    if not path.is_file():
        raise CollabError("音频文件不在本机", status=404)
    member = _member(group, device_code)
    # 烧毁模式在客户端「播完/离开」时调用 consume 才真正烧掉，避免 <audio> 的多次 Range
    # 请求把授权瞬间用光、导致播放中途 403。
    _log(group, member, "play_audio", material_id, approval.get("mode", ""), dedupe_sec=60)
    _save(group)
    return path, material.get("format", ""), approval


def consume_playback(group_id: str, approval_id: str, device_code: str) -> dict:
    """烧毁模式收尾：前端播放结束/离开时上报，之后同一审批不可再用。"""
    group = load_group(group_id)
    _require(group, device_code, "view")
    approval = _find_approval(group, approval_id)
    if approval is None:
        raise CollabError("播放审批不存在", status=404)
    if approval.get("device_code") != device_code:
        raise CollabError("这条审批不属于当前设备", status=403)
    if approval.get("mode") != "burn":
        return approval
    if approval.get("status") == "approved":
        approval["status"] = "used"
        approval["used_at"] = _now()
        _log(group, _member(group, device_code), "consume_playback", approval.get("material_id"), "烧毁")
        _save(group)
    return approval


# ---------- 单次 / 单材料授权（PRD 12.4） ----------


def create_grant(
    group_id: str,
    device_code: str,
    target: str,
    caps: list[str],
    scope: str = "material",
    material_ids: list[str] | None = None,
    uses: int | None = None,
    days: int | None = None,
    note: str = "",
) -> dict:
    """在长期角色模板之外，给某个成员发一次性 / 单材料授权。

    - scope=material 时，授权只对 material_ids 里的材料生效；
    - uses=1 即「单次」，用掉一次自动失效；None 表示不限次数；
    - days 给定时到期自动失效。
    """
    group = load_group(group_id)
    actor = _require(group, device_code, "approve")
    target_member = _member(group, target)
    if target_member is None:
        raise CollabError("成员不存在", status=404)
    if target_member.get("role") == "owner":
        raise CollabError("群主不需要额外授权", status=400)
    if not isinstance(caps, list) or not caps or not all(c in VALID_GRANT_CAPS for c in caps):
        raise CollabError(f"授权能力只能是 {', '.join(VALID_GRANT_CAPS)}")
    if scope not in ("group", "material"):
        raise CollabError("scope 只能是 group 或 material")
    materials = group.get("materials", [])
    material_ids = [str(m) for m in (material_ids or [])]
    if scope == "material":
        if not material_ids:
            raise CollabError("单材料授权必须指定材料")
        known = {m.get("id") for m in materials}
        unknown = [m for m in material_ids if m not in known]
        if unknown:
            raise CollabError("指定的材料不存在", status=404)
    else:
        material_ids = []
    if uses is not None:
        try:
            uses = int(uses)
        except (TypeError, ValueError):
            raise CollabError("uses 必须是整数")
        if uses < 1 or uses > 999:
            raise CollabError("uses 需在 1–999 之间")
    if days is not None:
        try:
            days = int(days)
        except (TypeError, ValueError):
            raise CollabError("days 必须是整数")
        if days < 1 or days > 365:
            raise CollabError("有效天数需在 1–365 之间")
    now = _now()
    grant = {
        "id": storage.new_id(),
        "device_code": target,
        "nick": target_member.get("nick", ""),
        "caps": list(caps),
        "scope": scope,
        "material_ids": material_ids,
        "uses": uses,
        "used": 0,
        "expires_at": (_now_dt() + timedelta(days=days)).isoformat() if days else None,
        "note": note.strip(),
        "created_by": actor.get("nick", ""),
        "created_at": now,
        "revoked": False,
    }
    group.setdefault("grants", []).append(grant)
    _log(group, actor, "create_grant", ",".join(material_ids), f"{target_member.get('nick')} ← {', '.join(caps)}")
    _save(group)
    return grant


def list_grants(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    member = _require(group, device_code, "view")
    grants = group.get("grants", [])
    if "approve" not in _caps(group, member):
        grants = [g for g in grants if g.get("device_code") == device_code]
    return {"grants": grants}


def revoke_grant(group_id: str, grant_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "approve")
    grant = next((g for g in group.get("grants", []) if g.get("id") == grant_id), None)
    if grant is None:
        raise CollabError("授权不存在", status=404)
    grant["revoked"] = True
    grant["revoked_by"] = actor.get("nick", "")
    grant["revoked_at"] = _now()
    _log(group, actor, "revoke_grant", ",".join(grant.get("material_ids") or []), grant.get("nick", ""))
    _save(group)
    return grant


def access_log(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    _require(group, device_code, "members")
    return {"access": group.get("access", [])}
