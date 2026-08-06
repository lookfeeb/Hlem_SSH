import argparse
import base64
import hashlib
import json
import os
import posixpath
import queue
import signal
import socket
import stat
import threading
import time

import paramiko


HOST_KEY = paramiko.RSAKey.generate(2048)
RUNNING = True


def normalize_path(path):
    normalized = posixpath.normpath(path or "/")
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    return normalized


class MemoryStore:
    def __init__(self):
        self.lock = threading.RLock()
        self.files = {"/fixture.txt": bytearray(b"fixture\n")}

    def attributes(self, path, include_name=False):
        normalized = normalize_path(path)
        with self.lock:
            data = self.files.get(normalized)
            if data is None:
                return None
            size = len(data)
        attributes = paramiko.SFTPAttributes()
        if include_name:
            attributes.filename = posixpath.basename(normalized)
        attributes.st_mode = stat.S_IFREG | 0o644
        attributes.st_size = size
        attributes.st_uid = 0
        attributes.st_gid = 0
        attributes.st_atime = int(time.time())
        attributes.st_mtime = attributes.st_atime
        return attributes


STORE = MemoryStore()


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


class MemoryFileHandle(paramiko.SFTPHandle):
    def __init__(self, store, path, flags):
        super().__init__(flags)
        self.store = store
        self.path = normalize_path(path)
        self.flags = flags

    def read(self, offset, length):
        if self.flags & os.O_WRONLY:
            return paramiko.SFTP_PERMISSION_DENIED
        with self.store.lock:
            data = self.store.files.get(self.path)
            if data is None:
                return paramiko.SFTP_NO_SUCH_FILE
            return bytes(data[offset : offset + length])

    def write(self, offset, data):
        if not self.flags & (os.O_WRONLY | os.O_RDWR):
            return paramiko.SFTP_PERMISSION_DENIED
        with self.store.lock:
            target = self.store.files.get(self.path)
            if target is None:
                return paramiko.SFTP_NO_SUCH_FILE
            if self.flags & os.O_APPEND:
                offset = len(target)
            end = offset + len(data)
            if end > len(target):
                target.extend(b"\0" * (end - len(target)))
            target[offset:end] = data
        return paramiko.SFTP_OK

    def stat(self):
        return self.store.attributes(self.path) or paramiko.SFTP_NO_SUCH_FILE


class FixtureSftp(paramiko.SFTPServerInterface):
    def __init__(self, server, *args, store, **kwargs):
        super().__init__(server, *args, **kwargs)
        self.store = store

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

    def canonicalize(self, path):
        return normalize_path(path)

    def list_folder(self, path):
        if normalize_path(path) != "/":
            return paramiko.SFTP_NO_SUCH_FILE
        with self.store.lock:
            paths = sorted(self.store.files)
        return [self.store.attributes(path, include_name=True) for path in paths]

    def stat(self, path):
        normalized = normalize_path(path)
        if normalized == "/":
            return self.directory_attributes()
        return self.store.attributes(normalized) or paramiko.SFTP_NO_SUCH_FILE

    def lstat(self, path):
        return self.stat(path)

    def open(self, path, flags, attr):
        normalized = normalize_path(path)
        if posixpath.dirname(normalized) != "/":
            return paramiko.SFTP_NO_SUCH_FILE
        with self.store.lock:
            exists = normalized in self.store.files
            if exists and flags & os.O_EXCL and flags & os.O_CREAT:
                return paramiko.SFTP_FAILURE
            if not exists:
                if not flags & os.O_CREAT:
                    return paramiko.SFTP_NO_SUCH_FILE
                self.store.files[normalized] = bytearray()
            elif flags & os.O_TRUNC:
                self.store.files[normalized] = bytearray()
        return MemoryFileHandle(self.store, normalized, flags)

    def remove(self, path):
        normalized = normalize_path(path)
        with self.store.lock:
            if normalized not in self.store.files:
                return paramiko.SFTP_NO_SUCH_FILE
            del self.store.files[normalized]
        return paramiko.SFTP_OK

    def rename(self, oldpath, newpath):
        oldpath = normalize_path(oldpath)
        newpath = normalize_path(newpath)
        with self.store.lock:
            if oldpath not in self.store.files:
                return paramiko.SFTP_NO_SUCH_FILE
            self.store.files[newpath] = self.store.files.pop(oldpath)
        return paramiko.SFTP_OK

    def posix_rename(self, oldpath, newpath):
        return self.rename(oldpath, newpath)


def serve_client(client):
    transport = paramiko.Transport(client)
    transport.add_server_key(HOST_KEY)
    transport.set_subsystem_handler(
        "sftp",
        paramiko.SFTPServer,
        FixtureSftp,
        store=STORE,
    )
    try:
        transport.start_server(server=AuthServer())
        while RUNNING and transport.is_active():
            time.sleep(0.05)
    finally:
        transport.close()


def accept_sftp_clients(listener):
    while RUNNING:
        try:
            client, _ = listener.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=serve_client, args=(client,), daemon=True).start()


def relay(source, destination, delay_seconds):
    pending = queue.Queue()

    def send_pending():
        while True:
            item = pending.get()
            if item is None:
                break
            deliver_at, data = item
            remaining = deliver_at - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
            try:
                destination.sendall(data)
            except OSError:
                break
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    sender = threading.Thread(target=send_pending, daemon=True)
    sender.start()
    try:
        while RUNNING:
            data = source.recv(256 * 1024)
            if not data:
                break
            pending.put((time.monotonic() + delay_seconds, data))
    except OSError:
        pass
    finally:
        pending.put(None)
        sender.join()


def serve_proxy_client(client, backend_address, delay_seconds):
    backend = socket.create_connection(backend_address, timeout=10)
    backend.settimeout(None)
    client.settimeout(None)
    upstream = threading.Thread(
        target=relay,
        args=(client, backend, delay_seconds),
        daemon=True,
    )
    downstream = threading.Thread(
        target=relay,
        args=(backend, client, delay_seconds),
        daemon=True,
    )
    upstream.start()
    downstream.start()
    upstream.join()
    downstream.join()
    client.close()
    backend.close()


def stop_server(signum, frame):
    global RUNNING
    RUNNING = False


def create_listener():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    listener.settimeout(0.2)
    return listener


parser = argparse.ArgumentParser()
parser.add_argument(
    "--latency-ms",
    type=float,
    default=0,
    help="模拟的往返延迟（RTT，毫秒）",
)
args = parser.parse_args()

signal.signal(signal.SIGTERM, stop_server)
signal.signal(signal.SIGINT, stop_server)

backend_listener = create_listener()
backend_address = backend_listener.getsockname()
threading.Thread(
    target=accept_sftp_clients,
    args=(backend_listener,),
    daemon=True,
).start()

public_listener = create_listener()
one_way_delay_seconds = max(0.0, args.latency_ms) / 2000.0

fingerprint = base64.b64encode(hashlib.sha256(HOST_KEY.asbytes()).digest()).decode().rstrip("=")
print(
    json.dumps(
        {
            "port": public_listener.getsockname()[1],
            "fingerprint": f"SHA256:{fingerprint}",
            "latencyMs": args.latency_ms,
        }
    ),
    flush=True,
)

while RUNNING:
    try:
        client, _ = public_listener.accept()
    except socket.timeout:
        continue
    threading.Thread(
        target=serve_proxy_client,
        args=(client, backend_address, one_way_delay_seconds),
        daemon=True,
    ).start()

public_listener.close()
backend_listener.close()
