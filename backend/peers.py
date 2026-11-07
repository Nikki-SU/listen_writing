"""局域网 P2P：节点发现、跨机群组、无副本 / 有副本两种模式、同人多设备同步。

PRD 第 5 与 12 节要求「无中心服务器、只在局域网内使用」：
- 每个后端就是一个节点，UDP 广播互相发现（也支持手工填 IP，规避某些交换机关广播）；
- 无副本群组：群主节点是唯一权威，其他节点把请求原样转发给群主，群主不在线就明确报错；
- 有副本群组：每个节点都有完整副本，改动后互相推送快照，按修订号 / 三方合并收敛，
  真冲突保留本地文本并把对方文本做成待处理提案，交给人决定（PRD 12.2）；
- 昵称 + 设备码完全相同的多台设备视为同一个人，自动互相同步项目与录音。

本模块只做节点与数据同步，HTTP 路由仍在 main.py；不引入第三方依赖。
"""

import hashlib
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import collab
import storage

DISCOVERY_PORT = int(os.environ.get("LISTEN_WRITING_DISCOVERY_PORT") or 7851)
HTTP_PORT = int(os.environ.get("LISTEN_WRITING_PORT") or 7850)
# 节点标识要跨重启稳定，但不要把本机路径广播到局域网：用数据目录的哈希。
INSTANCE = hashlib.sha1(str(storage.DATA_ROOT.resolve()).encode("utf-8")).hexdigest()[:16]
ANNOUNCE_SEC = 4.0
PEER_TTL = 15.0
GROUP_RE = re.compile(r"^/api/groups/([^/]+)")

_started = False
_lock = threading.Lock()
_peers: dict[str, dict] = {}  # key=instance
_pull_cache: dict[str, float] = {}
_push_cache: dict[str, float] = {}
_sync_lock = threading.Lock()


# ---------- 节点注册表 ----------


def _identity() -> dict:
    return storage.get_settings()["identity"]


def _peer_key(device_code: str, instance: str) -> str:
    return instance or f"{device_code}@{device_code}"


def _register(device_code: str, nick: str, host: str, port: int, instance: str, groups: list[str], via: str) -> dict:
    key = _peer_key(device_code, instance)
    if instance == INSTANCE:
        return {}
    peer = {
        "key": key,
        "device_code": device_code,
        "nick": nick,
        "host": host,
        "port": int(port or HTTP_PORT),
        "instance": instance,
        "groups": list(groups or []),
        "via": via,
        "last_seen": time.time(),
    }
    with _lock:
        _peers[key] = peer
    return peer


def _base(peer: dict) -> str:
    host = peer.get("host") or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{peer.get('port') or HTTP_PORT}"


def peers() -> list[dict]:
    now = time.time()
    with _lock:
        alive = [p for p in _peers.values() if now - p.get("last_seen", 0) <= PEER_TTL]
    mine = _identity()
    for p in alive:
        p["online"] = True
        p["base_url"] = _base(p)
        p["same_identity"] = (
            p.get("device_code") == mine.get("device_code") and p.get("nick") == mine.get("nick")
        )
    alive.sort(key=lambda p: (not p.get("same_identity"), p.get("nick", "")))
    return alive


def snapshot() -> dict:
    return {
        "instance": INSTANCE,
        "http_port": HTTP_PORT,
        "discovery_port": DISCOVERY_PORT,
        "identity": _identity(),
        "peers": peers(),
    }


def register_peer(url: str, device_code: str = "", nick: str = "") -> dict:
    """手工添加节点：填 IP/URL，主动拉一次 /api/peer/info 完成登记。"""
    url = url.strip().rstrip("/")
    if not url.startswith("http://") and not url.startswith("https://"):
        url = f"http://{url}"
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    port = parsed.port or HTTP_PORT
    if not host:
        raise ValueError("节点地址无效")
    info = _http_json("GET", url, "/api/peer/info", timeout=4)
    identity = (info or {}).get("identity") or {}
    peer = _register(
        device_code or identity.get("device_code", device_code),
        nick or identity.get("nick", nick),
        host,
        port,
        (info or {}).get("instance") or f"manual:{host}:{port}",
        (info or {}).get("groups") or [],
        "manual",
    )
    return peer or {}


def remove_peer(key: str) -> None:
    key = urllib.parse.unquote(key)
    with _lock:
        for k, peer in list(_peers.items()):
            if k == key or peer.get("instance") == key or peer.get("device_code") == key:
                _peers.pop(k, None)


# ---------- HTTP 小工具 ----------


def _http_json(method: str, base: str, path: str, payload: dict | None = None, timeout: float = 6.0):
    url = base.rstrip("/") + path
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def _http_bytes(base: str, path: str, timeout: float = 30.0) -> bytes:
    req = urllib.request.Request(base.rstrip("/") + path, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _base_for(device_code: str) -> str | None:
    for peer in peers():
        if peer.get("device_code") == device_code:
            return peer.get("base_url")
    return None


def _bases_for_group(group_id: str) -> list[tuple[dict, str]]:
    return [(peer, peer.get("base_url")) for peer in peers() if group_id in (peer.get("groups") or [])]


# ---------- 发现：UDP 广播 ----------


def _announce_payload() -> dict:
    mine = _identity()
    groups = []
    root = collab.groups_root()
    if root.exists():
        for d in root.iterdir():
            g = collab.try_load_group(d.name)
            if g:
                groups.append(g.get("id"))
    return {
        "app": "listen_writing",
        "instance": INSTANCE,
        "device_code": mine.get("device_code", ""),
        "nick": mine.get("nick", ""),
        "port": HTTP_PORT,
        "groups": groups,
        "ts": time.time(),
    }


def _listener() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except OSError:
            pass
    try:
        sock.bind(("", DISCOVERY_PORT))
    except OSError:
        return
    while True:
        try:
            data, addr = sock.recvfrom(8192)
            msg = json.loads(data.decode("utf-8"))
            if msg.get("app") != "listen_writing":
                continue
            _register(
                str(msg.get("device_code") or ""),
                str(msg.get("nick") or ""),
                addr[0],
                int(msg.get("port") or HTTP_PORT),
                str(msg.get("instance") or ""),
                msg.get("groups") or [],
                "broadcast",
            )
        except Exception:
            continue


def _announcer() -> None:
    payload = json.dumps(_announce_payload(), ensure_ascii=False).encode("utf-8")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    while True:
        try:
            payload = json.dumps(_announce_payload(), ensure_ascii=False).encode("utf-8")
            for target in ("255.255.255.255", "127.255.255.255"):
                try:
                    sock.sendto(payload, (target, DISCOVERY_PORT))
                except OSError:
                    pass
        except Exception:
            pass
        time.sleep(ANNOUNCE_SEC)


def start() -> None:
    global _started
    if _started:
        return
    _started = True
    for target in (_listener, _announcer, _ping_loop, _project_sync_loop):
        threading.Thread(target=target, daemon=True).start()


def _ping_loop() -> None:
    """手工登记的节点没有广播可听，定期拉一次 info 保持在线状态与群组列表。"""
    while True:
        for peer in peers():
            if peer.get("via") != "manual":
                continue
            try:
                info = _http_json("GET", peer["base_url"], "/api/peer/info", timeout=4)
            except Exception:
                continue
            identity = (info or {}).get("identity") or {}
            _register(
                identity.get("device_code") or peer.get("device_code"),
                identity.get("nick") or peer.get("nick"),
                peer.get("host"),
                peer.get("port"),
                (info or {}).get("instance") or peer.get("instance"),
                (info or {}).get("groups") or [],
                "manual",
            )
        time.sleep(8)


# ---------- 群组：转发 / 快照同步 ----------


def maybe_forward(handler) -> bool:
    """在 main.Handler 分发前调用；返回 True 表示请求已被跨机处理。"""
    match = GROUP_RE.match(urllib.parse.urlparse(handler.path).path)
    if not match:
        return False
    group_id = match.group(1)
    group = collab.try_load_group(group_id)
    if group is None:
        return False
    my_device = _identity().get("device_code", "")
    if group.get("mode") == "authoritative" and group.get("owner_device") != my_device:
        base = group.get("authority_url") or _base_for(group.get("owner_device") or "")
        if not base:
            handler._send_json({
                "error": "群主节点不在线：无副本群组必须由群主在线才能使用",
                "code": "owner_offline",
            }, status=503)
            return True
        _forward(handler, base)
        return True
    if group.get("mode") == "replica":
        pull_group(group_id)
        if getattr(handler, "command", "GET") != "GET":
            handler._peer_sync_group = group_id
    return False


def after_request(handler) -> None:
    """响应成功后把有副本群组的新状态推给其他节点。"""
    group_id = getattr(handler, "_peer_sync_group", None)
    if group_id:
        threading.Thread(target=push_group, args=(group_id,), daemon=True).start()


def _forward(handler, base: str) -> None:
    body = handler._read_body()
    headers = {"Content-Type": handler.headers.get("Content-Type") or "application/json"}
    req = urllib.request.Request(base + handler.path, data=body or None, headers=headers, method=handler.command)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            status = resp.status
            content_type = resp.headers.get("Content-Type") or "application/json; charset=utf-8"
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
        content_type = exc.headers.get("Content-Type") or "application/json; charset=utf-8"
    except Exception:
        handler._send_json({
            "error": "群主节点不在线：无副本群组必须由群主在线才能使用",
            "code": "owner_offline",
        }, status=503)
        return
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def snapshot_group(group_id: str, device_code: str) -> dict:
    group = collab.try_load_group(group_id)
    if group is None:
        raise collab.CollabError("群组不存在", status=404)
    if collab._member(group, device_code) is None:
        raise collab.CollabError("你还没有加入这个群组", status=403)
    return group


def merge_snapshot(group_id: str, remote: dict, device_code: str) -> dict:
    """接收别的节点的有副本快照并合并；只有成员能推。"""
    local = collab.try_load_group(group_id)
    if local is None:
        if collab._member(remote, device_code) is None:
            raise collab.CollabError("你还没有加入这个群组", status=403)
        collab.import_group(remote)
        return remote
    if collab._member(local, device_code) is None:
        raise collab.CollabError("你还没有加入这个群组", status=403)
    if local.get("mode") != "replica":
        # 无副本群组以群主为准，成员推来的快照不覆盖权威数据。
        return local
    changed = _merge_group(local, remote)
    if changed:
        collab.import_group(local)
    return local


def pull_group(group_id: str) -> None:
    """有副本群组：访问前从在线节点拉一次，合并到本地。"""
    now = time.time()
    with _lock:
        if now - _pull_cache.get(group_id, 0) < 1.5:
            return
        _pull_cache[group_id] = now
    local = collab.try_load_group(group_id)
    if local is None or local.get("mode") != "replica":
        return
    my_device = _identity().get("device_code", "")
    pulled = False
    for peer in peers():
        try:
            remote = _http_json(
                "GET", peer["base_url"],
                f"/api/peer/groups/{urllib.parse.quote(group_id)}/snapshot?device_code={urllib.parse.quote(my_device)}",
                timeout=6,
            )
        except Exception:
            continue
        if not remote or remote.get("mode") != "replica":
            continue
        pulled = True
        if _merge_group(local, remote):
            collab.import_group(local)
        _pull_media(local, peer)
    if pulled:
        # 拉取只能把对方的变化带进来；本机在离线期间产生的修改要靠推送才能回到对方。
        # 只在 GET 时拉取的话，纯浏览流量永远无法让两端收敛，所以拉完补一次推送。
        threading.Thread(target=push_group, args=(group_id,), daemon=True).start()


def push_group(group_id: str) -> None:
    now = time.time()
    with _lock:
        if now - _push_cache.get(group_id, 0) < 0.8:
            return
        _push_cache[group_id] = now
    group = collab.try_load_group(group_id)
    if group is None or group.get("mode") != "replica":
        return
    my_device = _identity().get("device_code", "")
    for peer in peers():
        try:
            _http_json(
                "POST", peer["base_url"],
                f"/api/peer/groups/{urllib.parse.quote(group_id)}/snapshot?device_code={urllib.parse.quote(my_device)}",
                group,
                timeout=8,
            )
        except Exception:
            continue


def import_group_by_code(code: str) -> bool:
    """本机没有这个配对码时，向发现到的节点要一份群组快照。"""
    if not code.strip():
        return False
    my_device = _identity().get("device_code", "")
    for peer in peers():
        try:
            group = _http_json(
                "GET", peer["base_url"],
                f"/api/peer/groups/by-code/{urllib.parse.quote(code.strip())}?device_code={urllib.parse.quote(my_device)}",
                timeout=6,
            )
        except Exception:
            continue
        if not group or not group.get("id"):
            continue
        group["authority_url"] = peer["base_url"] if group.get("mode") == "authoritative" else ""
        group.setdefault("grants", [])
        collab.import_group(group)
        return True
    return False


def push_join(group: dict, device_code: str, nick: str, role: str) -> None:
    """本机加入后，把成员身份同步到群主 / 其他节点。"""
    base = group.get("authority_url") or _base_for(group.get("owner_device") or "")
    if not base:
        return
    try:
        _http_json(
            "POST", base,
            f"/api/peer/groups/{urllib.parse.quote(group['id'])}/join",
            {"code": group.get("code", ""), "device_code": device_code, "nick": nick, "role": role},
            timeout=6,
        )
    except Exception:
        pass


# ---------- 有副本合并 ----------


def _version_key(version: str) -> tuple[int, int]:
    stage, _, seq = str(version or "0.0").partition(".")
    try:
        return int(stage), int(seq)
    except ValueError:
        return 0, 0


def _merge_members(local: dict, remote: dict) -> bool:
    changed = False
    by_code = {m.get("device_code"): m for m in local.get("members", [])}
    for m in remote.get("members", []):
        cur = by_code.get(m.get("device_code"))
        if cur is None:
            local.setdefault("members", []).append(m)
            changed = True
        elif (m.get("updated_at") or m.get("joined_at") or "") > (cur.get("updated_at") or cur.get("joined_at") or ""):
            cur.update(m)
            changed = True
    return changed


def _merge_roles(local: dict, remote: dict) -> bool:
    changed = False
    roles = local.setdefault("roles", {})
    for key, value in (remote.get("roles") or {}).items():
        cur = roles.get(key)
        if cur is None:
            roles[key] = value
            changed = True
        elif (value.get("updated_at") or "") > (cur.get("updated_at") or ""):
            roles[key] = value
            changed = True
    return changed


def _same_sentences(left: dict, right: dict) -> bool:
    def key(material: dict) -> list[tuple]:
        return sorted(
            (s.get("id"), s.get("text"), s.get("speaker"))
            for s in material.get("sentences", [])
        )
    return key(left) == key(right)


def _merge_material(local: dict, remote: dict, group: dict) -> bool:
    """单个材料的合并：不同句子各自落地，同一句冲突做成待处理提案。

    判断快进用修订集合而不是版本号：两端各自 +1 后版本号会碰撞，
    修订号唯一，能区分「远程真的包含我的改动」和「各自从同一基线改出去」。
    """
    lrev = local.get("rev") or ""
    rrev = remote.get("rev") or ""
    if not lrev or not rrev:
        return _merge_material_legacy(local, remote, group)
    lrevs = local.get("revs") or [lrev]
    rrevs = remote.get("revs") or [rrev]
    if rrev in lrevs:
        # 远程当前修订已在本地已知集合里，本地不会更旧。
        return False
    if lrev in rrevs:
        # 远程已经包含本地当前修订，直接快进到远程。
        keep_source = local.get("source_device", "")
        local.update(remote)
        if keep_source and not local.get("source_device"):
            local["source_device"] = keep_source
        return True
    if _same_sentences(local, remote):
        merged_revs = list(dict.fromkeys(lrevs + rrevs))
        if merged_revs != list(local.get("revs") or []):
            local["revs"] = merged_revs[-200:]
            return True
        return False
    return _three_way_material(local, remote, group)


def _merge_material_legacy(local: dict, remote: dict, group: dict) -> bool:
    """没有修订号的历史数据：退回版本号 + 历史启发式。"""
    lv = _version_key(local.get("version"))
    rv = _version_key(remote.get("version"))
    if lv == rv:
        if _same_sentences(local, remote):
            return False
        return _three_way_material(local, remote, group)
    if rv > lv:
        remote_history = {h.get("version") for h in remote.get("history", [])}
        if not remote_history or local.get("version") in remote_history:
            keep_source = local.get("source_device", "")
            local.update(remote)
            if keep_source and not local.get("source_device"):
                local["source_device"] = keep_source
            return True
        return _three_way_material(local, remote, group)
    if remote.get("version") in {h.get("version") for h in local.get("history", [])}:
        return False
    return _three_way_material(local, remote, group)


def _three_way_material(local: dict, remote: dict, group: dict) -> bool:
    base_map = {s.get("id"): s for s in local.get("base_sentences", [])}
    local_map = {s.get("id"): s for s in local.get("sentences", [])}
    remote_map = {s.get("id"): s for s in remote.get("sentences", [])}
    merged: dict[str, dict] = {}
    conflicts = []
    for sid in set(local_map) | set(remote_map):
        mine = local_map.get(sid)
        theirs = remote_map.get(sid)
        ancestor = base_map.get(sid)
        if mine is None:
            merged[sid] = theirs
        elif theirs is None:
            merged[sid] = mine
        elif (mine.get("text"), mine.get("speaker")) == (theirs.get("text"), theirs.get("speaker")):
            merged[sid] = mine
        elif ancestor is not None and (mine.get("text"), mine.get("speaker")) == (
            ancestor.get("text"), ancestor.get("speaker")
        ):
            merged[sid] = theirs
        elif ancestor is not None and (theirs.get("text"), theirs.get("speaker")) == (
            ancestor.get("text"), ancestor.get("speaker")
        ):
            merged[sid] = mine
        else:
            merged[sid] = mine
            conflicts.append({"mine": mine, "theirs": theirs})
    if not conflicts and _same_sentences({"sentences": list(merged.values())}, local):
        # 内容一致：只把对方的修订号并进来，避免下次被误判成分叉。
        merged_revs = list(dict.fromkeys((local.get("revs") or []) + (remote.get("revs") or [])))
        if merged_revs != list(local.get("revs") or []):
            local["revs"] = merged_revs[-200:]
            return True
        return False
    ordered = sorted(merged.values(), key=lambda s: int(s.get("index", 0)))
    conflict_ids = {item["mine"].get("id") for item in conflicts}
    new_base = []
    for sid, sentence in merged.items():
        if sid in conflict_ids:
            # 冲突句的基线保持原样，后续同步才不会被误当成「只有对方改过」。
            new_base.append(base_map.get(sid) or sentence)
        else:
            new_base.append(sentence)
    local["sentences"] = ordered
    local["base_sentences"] = sorted(new_base, key=lambda s: int(s.get("index", 0)))
    local["version"] = collab._version_next(local.get("version", "2.0"))
    local["updated_at"] = collab._now()
    local["revs"] = list(dict.fromkeys(
        (local.get("revs") or []) + (remote.get("revs") or [])
    ))[-200:]
    collab._bump_revision(local)
    local.setdefault("history", []).append({
        "version": local["version"],
        "stage": int(local.get("stage", 0)),
        "at": collab._now(),
        "by": "跨机同步",
        "message": (
            f"自动合并，{len(conflicts)} 处冲突待人工确认" if conflicts else "自动合并不同句子的修改"
        ),
    })
    if not conflicts:
        return True
    existing = {
        (p.get("sentence_id"), p.get("after"))
        for p in group.setdefault("proposals", [])
        if p.get("status") in ("pending", "conflict")
    }
    for item in conflicts:
        mine, theirs = item["mine"], item["theirs"]
        key = (mine.get("id"), theirs.get("text"))
        if key in existing:
            continue
        group["proposals"].append({
            "id": storage.new_id(),
            "material_id": local.get("id"),
            "sentence_id": mine.get("id"),
            "index": int(mine.get("index", 0)),
            "before": mine.get("text", ""),
            "after": theirs.get("text", ""),
            "by_device": "",
            "by": f"节点 {remote.get('name', '')}",
            "created_at": collab._now(),
            "status": "conflict",
            "origin": "sync",
        })
    return True


def _merge_group(local: dict, remote: dict) -> bool:
    changed = False
    changed |= _merge_members(local, remote)
    changed |= _merge_roles(local, remote)

    local_materials = {m.get("id"): m for m in local.get("materials", [])}
    for rm in remote.get("materials", []):
        lm = local_materials.get(rm.get("id"))
        if lm is None:
            local.setdefault("materials", []).append(rm)
            changed = True
        else:
            changed |= _merge_material(lm, rm, local)

    def union(key: str, prefer):
        nonlocal changed
        by_id = {x.get("id"): x for x in local.get(key, [])}
        for item in remote.get(key, []):
            cur = by_id.get(item.get("id"))
            if cur is None:
                local.setdefault(key, []).append(item)
                changed = True
            else:
                winner = prefer(cur, item)
                if winner is not cur:
                    cur.update(winner)
                    changed = True

    def latest(a: dict, b: dict) -> dict:
        return a if (a.get("decided_at") or a.get("created_at") or "") >= (
            b.get("decided_at") or b.get("created_at") or ""
        ) else b

    union("proposals", latest)
    union("approvals", latest)
    union("grants", latest)
    if len(local.get("access", [])) < 500:
        seen = {a.get("id") for a in local.get("access", [])}
        for item in remote.get("access", []):
            if item.get("id") not in seen:
                local.setdefault("access", []).append(item)
                changed = True
        local["access"] = local["access"][-500:]
    return changed


# ---------- 同人多设备：项目 / 录音同步 ----------


def _project_sync_loop() -> None:
    while True:
        try:
            sync_identity_projects()
        except Exception:
            pass
        time.sleep(20)


def sync_identity_projects() -> None:
    if not _sync_lock.acquire(blocking=False):
        return
    try:
        mine = _identity()
        for peer in peers():
            if not peer.get("same_identity"):
                continue
            _pull_projects(peer, mine)
    finally:
        _sync_lock.release()


def _pull_projects(peer: dict, mine: dict) -> None:
    base = peer["base_url"]
    query = f"?device_code={urllib.parse.quote(mine.get('device_code', ''))}&nick={urllib.parse.quote(mine.get('nick', ''))}"
    try:
        data = _http_json("GET", base, "/api/peer/projects" + query, timeout=8)
    except Exception:
        return
    for remote_project in (data or {}).get("projects", []):
        local_project = storage.get_project(remote_project.get("id"))
        if local_project is None:
            storage.project_dir(remote_project["id"]).mkdir(parents=True, exist_ok=True)
            storage._write_json(storage.project_dir(remote_project["id"]) / "project.json", remote_project)
        for remote_rec in remote_project.get("recordings", []):
            pid, rid = remote_project["id"], remote_rec.get("id")
            local_rec = storage.get_recording(pid, rid)
            if local_rec is not None:
                rk = _version_key((remote_rec.get("version") or {}).get("current"))
                lk = _version_key((local_rec.get("version") or {}).get("current"))
                if rk <= lk:
                    continue
            try:
                bundle = _http_json(
                    "GET", base,
                    f"/api/peer/projects/{urllib.parse.quote(pid)}/recordings/{urllib.parse.quote(rid)}/bundle" + query,
                    timeout=15,
                )
            except Exception:
                continue
            if not bundle:
                continue
            _apply_bundle(bundle)
            current = storage.get_recording(pid, rid) or {}
            audio = current.get("audio_path") or ""
            if not audio or not Path(audio).is_file():
                _pull_audio(peer, pid, rid, bundle.get("recording") or remote_rec)


def _apply_bundle(bundle: dict) -> None:
    recording = bundle.get("recording") or {}
    project = bundle.get("project") or {}
    pid, rid = project.get("id"), recording.get("id")
    if not pid or not rid:
        return
    if storage.get_project(pid) is None:
        storage.project_dir(pid).mkdir(parents=True, exist_ok=True)
        storage._write_json(storage.project_dir(pid) / "project.json", project)
    local_rec = storage.get_recording(pid, rid)
    if local_rec is not None and local_rec.get("audio_path") and Path(local_rec["audio_path"]).is_file():
        recording["audio_path"] = local_rec["audio_path"]
    storage.recording_dir(pid, rid).mkdir(parents=True, exist_ok=True)
    storage._write_json(storage.recording_dir(pid, rid) / "recording.json", recording)
    storage.save_sentences(pid, rid, bundle.get("sentences") or [])
    storage.save_redactions(pid, rid, bundle.get("redactions") or [])
    storage.save_redaction_categories(pid, bundle.get("categories") or [])
    for version in bundle.get("versions") or []:
        storage.save_version(
            pid, rid,
            int(version.get("stage", 0)),
            int(version.get("seq", 1)),
            version,
        )


def _pull_audio(peer: dict, project_id: str, recording_id: str, recording: dict) -> None:
    fmt = (recording.get("format") or "wav").lower()
    # 同人同步时 peer 的身份就是本机身份；跨机拉材料音频时 peer 里带的是来源节点身份。
    device = peer.get("device_code") or _identity().get("device_code", "")
    nick = peer.get("nick") or _identity().get("nick", "")
    query = (
        f"?device_code={urllib.parse.quote(device)}"
        f"&nick={urllib.parse.quote(nick)}"
    )
    try:
        raw = _http_bytes(
            peer["base_url"],
            f"/api/peer/projects/{urllib.parse.quote(project_id)}/recordings/{urllib.parse.quote(recording_id)}/audio" + query,
            timeout=120,
        )
    except Exception:
        return
    if not raw:
        return
    path = storage.save_audio(project_id, recording_id, fmt, raw)
    storage.update_recording(project_id, recording_id, audio_path=path)


def _pull_media(group: dict, fallback_peer: dict) -> None:
    """有副本群组：本机缺材料对应的录音时，从来源节点拉一份。"""
    for material in group.get("materials", []):
        pid, rid = material.get("project_id"), material.get("recording_id")
        if not pid or not rid:
            continue
        if storage.get_recording(pid, rid) is not None:
            continue
        source = _base_for(material.get("source_device") or "") or fallback_peer.get("base_url")
        if not source:
            continue
        # 项目/录音接口只对「声称自己是该节点主人」的请求开放；跨机拉材料音频时
        # 必须用来源节点自己的身份，而不是拉取方（材料成员）的身份。
        owner = next((p for p in peers() if p.get("base_url") == source), None) or fallback_peer
        device = owner.get("device_code") or _identity().get("device_code", "")
        nick = owner.get("nick") or _identity().get("nick", "")
        query = (
            f"?device_code={urllib.parse.quote(device)}"
            f"&nick={urllib.parse.quote(nick)}"
        )
        try:
            bundle = _http_json(
                "GET", source,
                f"/api/peer/projects/{urllib.parse.quote(pid)}/recordings/{urllib.parse.quote(rid)}/bundle" + query,
                timeout=15,
            )
        except Exception:
            continue
        if not bundle:
            continue
        _apply_bundle(bundle)
        fake_peer = {"base_url": source, "device_code": device, "nick": nick}
        _pull_audio(fake_peer, pid, rid, bundle.get("recording") or {})
