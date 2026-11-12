import base64
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = "/var/lib/fake-github/requests.jsonl"
UPSTREAM = "/var/lib/fake-github/upstream.json"
APP_ID = "654321"
INSTALLATION_TOKEN = "ghs_fake_installation_token"


def decode(segment):
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


def upstream_state():
    try:
        with open(UPSTREAM) as state:
            return json.load(state)
    except FileNotFoundError:
        return {"fail": False, "dispatchFail": False, "repos": {}}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def reply_dispatch(self):
        if upstream_state().get("dispatchFail"):
            self.reply(500, {"message": "Server Error"})
        else:
            self.send_response(204)
            self.send_header("content-length", "0")
            self.end_headers()

    def reply_upstream(self):
        state = upstream_state()
        segments = self.path.split("/")
        repo = state["repos"].get("/".join(segments[2:4]))
        if state["fail"]:
            self.reply(500, {"message": "Server Error"})
        elif repo is None or len(segments) < 6:
            self.reply(404, {"message": "Not Found"})
        elif segments[4] == "commits":
            self.reply(200, {"sha": repo["head"]})
        elif segments[4] == "compare":
            base, _, head = "/".join(segments[5:]).partition("...")
            if base in repo["ahead"] and head == repo["head"]:
                self.reply(200, {"ahead_by": repo["ahead"][base]})
            else:
                self.reply(404, {"message": "Not Found"})
        else:
            self.reply(404, {"message": "Not Found"})

    def handle_request(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        scheme, _, credential = (self.headers.get("authorization") or "").partition(" ")
        segments = credential.split(".")
        upstream = self.path.startswith("/repos/") and not self.path.endswith("/installation")
        if upstream:
            signed = scheme == "Bearer" and credential == INSTALLATION_TOKEN
        else:
            signed = scheme == "Bearer" and len(segments) == 3 and decode(segments[1]).get("iss") == APP_ID
        with open(LOG, "a") as log:
            log.write(json.dumps({"method": self.command, "path": self.path, "signed": signed, "body": body}) + "\n")
        if not signed:
            self.reply(401, {"message": "Bad credentials"})
        elif upstream and self.command == "GET":
            self.reply_upstream()
        elif self.command == "POST" and self.path == "/repos/operator-org/operator/actions/workflows/forge-bump.yml/dispatches":
            self.reply_dispatch()
        elif self.command == "GET" and self.path == "/repos/operator-org/operator/installation":
            self.reply(200, {"id": 42})
        elif self.command == "POST" and self.path == "/app/installations/42/access_tokens":
            self.reply(201, {"token": INSTALLATION_TOKEN, "expires_at": "2099-01-01T00:00:00Z"})
        else:
            self.reply(404, {"message": "Not Found"})

    do_GET = handle_request
    do_POST = handle_request

    def log_message(self, *args):
        sys.stderr.write(" ".join(map(str, args)) + "\n")


HTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
