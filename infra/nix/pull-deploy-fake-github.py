import base64
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = "/var/lib/fake-github/requests.jsonl"
APP_ID = "123456"


def decode(segment):
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_request(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        scheme, _, credential = (self.headers.get("authorization") or "").partition(" ")
        segments = credential.split(".")
        signed = scheme == "Bearer" and len(segments) == 3 and decode(segments[1]).get("iss") == APP_ID
        with open(LOG, "a") as log:
            log.write(json.dumps({"method": self.command, "path": self.path, "signed": signed, "body": body}) + "\n")
        if not signed:
            self.reply(401, {"message": "Bad credentials"})
        elif self.command == "GET" and self.path == "/repos/operator-org/operator/installation":
            self.reply(200, {"id": 42})
        elif self.command == "POST" and self.path == "/app/installations/42/access_tokens":
            self.reply(201, {"token": "ghs_fake_installation_token", "expires_at": "2099-01-01T00:00:00Z"})
        else:
            self.reply(404, {"message": "Not Found"})

    do_GET = handle_request
    do_POST = handle_request

    def log_message(self, *args):
        sys.stderr.write(" ".join(map(str, args)) + "\n")


HTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
