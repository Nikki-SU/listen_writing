"""局域网协作：配对码群组、四级可自定义权限、材料快照、提案合并、只读播放审批、审查模式。

数据落盘在 `data/groups/<群组 id>/group.json`，仍遵守「人可读 JSON」的存储纪律。
所有写操作返回最新对象，由 main.py 负责 HTTP 编排；本模块只做数据与规则，不碰 HTTP。
"""

import json
import secrets
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


def _require(group: dict, device_code: str, cap: str) -> dict:
    member = _member(group, device_code)
    if member is None:
        raise CollabError("你还没有加入这个群组", status=403)
    if cap not in _caps(group, member):
        raise CollabError(f"当前权限（{_role(group, member).get('name')}）不允许此操作", status=403)
    return member


def _is_reviewer(group: dict, member: dict) -> bool:
    return "review" in _caps(group, member) and "edit" not in _caps(group, member)


def _log(group: dict, member: dict | None, action: str, material_id: str = "", detail: str = "") -> None:
    logs = group.setdefault("access", [])
    logs.append({
        "id": storage.new_id(),
        "at": _now(),
        "device_code": (member or {}).get("device_code", ""),
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


# ---------- 群组 CRUD ----------


def create_group(name: str, mode: str, device_code: str, nick: str) -> dict:
    name = name.strip()
    if not name:
        raise CollabError("群组名称不能为空")
    if mode not in ("authoritative", "replica"):
        raise CollabError("mode 只能是 authoritative 或 replica")
    now = _now()
    group = {
        "id": storage.new_id(),
        "name": name,
        "code": _unique_code(),
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


def join_group(code: str, device_code: str, nick: str, role: str) -> dict:
    code = code.strip()
    group = next((g for g in _all_groups() if g.get("code") == code), None)
    if group is None:
        raise CollabError("配对码不存在或已失效", status=404)
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
    material = {
        "id": storage.new_id(),
        "name": recording.get("name", ""),
        "project_id": project_id,
        "recording_id": recording_id,
        "stage": int(current.get("stage", 0)),
        "version": version,
        "sentences": sentences,
        # 三方合并的基线：最后一次灌入 / 合并时的快照
        "base_sentences": sentences,
        "redactions": storage.get_redactions(project_id, recording_id),
        "audio_path": recording.get("audio_path", ""),
        "format": recording.get("format", ""),
        "added_at": _now(),
        "added_by": actor.get("nick", ""),
        "history": [{"version": version, "stage": int(current.get("stage", 0)), "at": _now(), "by": actor.get("nick", ""), "message": "灌入当前版本"}],
    }
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


def _visible(group: dict, member: dict) -> list[dict]:
    materials = group.get("materials", [])
    if _is_reviewer(group, member):
        # 审查可见范围从版本 2 之后开始（PRD 13）。
        materials = [m for m in materials if int(m.get("stage", 0)) >= 2]
    return materials


def list_materials(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    member = _require(group, device_code, "view")
    return {"materials": [_material_meta(group, m, member) for m in _visible(group, member)]}


def get_material(group_id: str, material_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    member = _require(group, device_code, "view")
    material = next((m for m in _visible(group, member) if m.get("id") == material_id), None)
    if material is None:
        if _is_reviewer(group, member):
            raise CollabError("审查模式仅可查看阶段 2 之后的版本", status=403)
        raise CollabError("材料不存在", status=404)

    sentences = material.get("sentences", [])
    if _is_reviewer(group, member):
        # 审查者只看脱敏后的正文，且历史被截断到阶段 2 之后。
        from main import _apply_redactions  # 延迟导入，避免循环依赖

        sentences = _apply_redactions(sentences, material.get("redactions", []))
        history = [h for h in material.get("history", []) if int(h.get("stage", 0)) >= 2]
    else:
        history = material.get("history", [])

    playback, approval = _playback_state(group, material, member)
    _log(group, member, "view_material", material_id, "审查模式" if _is_reviewer(group, member) else "")
    _save(group)
    return {
        "material": {
            **_material_meta(group, material, member),
            "sentences": sentences,
            "history": history,
            "redactions": material.get("redactions", []) if not _is_reviewer(group, member) else [],
        },
        "can_play": playback,
        "approval": approval,
        "review_mode": _is_reviewer(group, member),
    }


# ---------- 提案（PR 式逐条合并） ----------


def create_proposal(group_id: str, material_id: str, sentence_id: str, after: str, device_code: str) -> dict:
    group = load_group(group_id)
    actor = _require(group, device_code, "submit")
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
    _require(group, device_code, "view")
    return {"proposals": group.get("proposals", [])}


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
    target["text"] = proposal.get("after", "")
    material["version"] = _version_next(material.get("version", "2.0"))
    material.setdefault("history", []).append({
        "version": material["version"],
        "stage": int(material.get("stage", 0)),
        "at": _now(),
        "by": actor.get("nick", ""),
        "message": f"合并第 {proposal['index'] + 1} 句（{proposal.get('by', '')} 提交）",
    })
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
    material["sentences"] = ordered
    material["base_sentences"] = ordered
    material["version"] = _version_next(material.get("version", "2.0"))
    material.setdefault("history", []).append({
        "version": material["version"],
        "stage": int(material.get("stage", 0)),
        "at": _now(),
        "by": actor.get("nick", ""),
        "message": "节点合并（三方自动合并）" if not conflicts else "节点合并（冲突句强制采用本地版本）",
    })
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
    if "view" not in _caps(group, member):
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
    actor = _require(group, device_code, "view")
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
        raise CollabError("音频文件不在本机", status=404)
    member = _member(group, device_code)
    # 烧毁模式在客户端「播完/离开」时调用 consume 才真正烧掉，避免 <audio> 的多次 Range
    # 请求把授权瞬间用光、导致播放中途 403。
    _log(group, member, "play_audio", material_id, approval.get("mode", ""))
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


def access_log(group_id: str, device_code: str) -> dict:
    group = load_group(group_id)
    _require(group, device_code, "members")
    return {"access": group.get("access", [])}
