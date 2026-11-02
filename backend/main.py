"""listen_writing 本地后端（骨架）。

产品本体：本地后端承载模型、推理、文件读写、局域网协作。
骨架阶段只提供健康检查与软件版本号，用于先把「后端启动 → 前端连接」这条链路跑通。
数据存储：人可读文本（CSV / JSON / Markdown），见《工程纪律.md》第三板块第 4 条。
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json

from models import APP_VERSION

PORT = 7850
HOST = "127.0.0.1"


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            self._send_json({"status": "ok"})
        elif self.path == "/api/version":
            self._send_json({"version": APP_VERSION})
        else:
            self._send_json({"error": "not found"}, status=404)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"listen_writing backend listening on http://{HOST}:{PORT}")
    server.serve_forever()