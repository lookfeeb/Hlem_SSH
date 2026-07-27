import base64
import hashlib
import json
import signal
import socket
import stat
import threading
import time

import paramiko


HOST_KEY = paramiko.RSAKey.generate(2048)
RUNNING = True


class AuthServer(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        if username == "helm-test" and password == "helm-test":
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class FixtureSftp(paramiko.SFTPServerInterface):
    @staticmethod
    def directory_attributes():
        attributes = paramiko.SFTPAttributes()
        attributes.st_mode = stat.S_IFDIR | 0o755
        attributes.st_size = 0
        attributes.st_uid = 0
        attributes.st_gid = 0
        attributes.st_atime = int(time.time())
        attributes.st_mtime = attributes.st_atime
        return attributes

    @staticmethod
    def file_attributes():
        attributes = paramiko.SFTPAttributes()
        attributes.filename = "fixture.txt"
        attributes.st_mode = stat.S_IFREG | 0o644
        attributes.st_size = len(b"fixture\n")
        attributes.st_uid = 0
        attributes.st_gid = 0
        attributes.st_atime = int(time.time())
        attributes.st_mtime = attributes.st_atime
        return attributes

    def canonicalize(self, path):
        return "/" if path in ("", ".", "/") else path

    def list_folder(self, path):
        if path != "/":
            return paramiko.SFTP_NO_SUCH_FILE
        return [self.file_attributes()]

    def stat(self, path):
        if path == "/":
            return self.directory_attributes()
        if path == "/fixture.txt":
            return self.file_attributes()
        return paramiko.SFTP_NO_SUCH_FILE

    def lstat(self, path):
        return self.stat(path)


def serve_client(client):
    transport = paramiko.Transport(client)
    transport.add_server_key(HOST_KEY)
    transport.set_subsystem_handler("sftp", paramiko.SFTPServer, FixtureSftp)
    try:
        transport.start_server(server=AuthServer())
        while RUNNING and transport.is_active():
            time.sleep(0.05)
    finally:
        transport.close()


def stop_server(signum, frame):
    global RUNNING
    RUNNING = False


signal.signal(signal.SIGTERM, stop_server)
signal.signal(signal.SIGINT, stop_server)

listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", 0))
listener.listen(16)
listener.settimeout(0.2)

fingerprint = base64.b64encode(hashlib.sha256(HOST_KEY.asbytes()).digest()).decode().rstrip("=")
print(json.dumps({"port": listener.getsockname()[1], "fingerprint": f"SHA256:{fingerprint}"}), flush=True)

while RUNNING:
    try:
        client, _ = listener.accept()
    except socket.timeout:
        continue
    threading.Thread(target=serve_client, args=(client,), daemon=True).start()

listener.close()
