import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
import unicodedata
from contextlib import closing
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATABASE_PATH = Path(os.environ.get("VOUCHER_DATABASE", ROOT / "data" / "vouchers.sqlite3"))
DEFAULT_LIMIT = 100
MAX_LIMIT = 1_000_000
MAX_VOUCHER_CODE_LENGTH = 256
MAX_VOUCHER_QUESTION_LENGTH = 512
MAX_VOUCHER_ANSWER_LENGTH = 256
ANSWER_HASH_ITERATIONS = 200_000
SESSION_LIFETIME = 8 * 60 * 60
SESSION_SECRET = (
    os.environ["VOUCHER_SESSION_SECRET"].encode("utf-8")
    if os.environ.get("VOUCHER_SESSION_SECRET")
    else secrets.token_bytes(32)
)
COOKIE_SECURE = (
    os.environ.get("VOUCHER_COOKIE_SECURE") == "1"
    or (os.environ.get("VOUCHER_COOKIE_SECURE") != "0" and bool(os.environ.get("RENDER")))
)
ADMIN_PASSWORD = os.environ.get("VOUCHER_ADMIN_PASSWORD")
GENERATED_ADMIN_PASSWORD = not ADMIN_PASSWORD
if GENERATED_ADMIN_PASSWORD:
    ADMIN_PASSWORD = secrets.token_urlsafe(18)


class VoucherError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def resolve_database_path(path=None):
    return DATABASE_PATH if path is None else path


def connect_database(path=None):
    connection = sqlite3.connect(resolve_database_path(path), timeout=15, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 15000")
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database(path=None, initial_limit=DEFAULT_LIMIT):
    db_path = resolve_database_path(path)
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with closing(connect_database(db_path)) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS campaign_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                max_vouchers INTEGER NOT NULL CHECK (max_vouchers > 0),
                started_at TEXT NOT NULL,
                voucher_code TEXT NOT NULL DEFAULT '',
                voucher_question TEXT NOT NULL DEFAULT '',
                answer_salt TEXT NOT NULL DEFAULT '',
                answer_hash TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS vouchers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL COLLATE NOCASE,
                created_at TEXT NOT NULL
            );
            """
        )
        settings_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(campaign_settings)")
        }
        if "voucher_code" not in settings_columns:
            connection.execute(
                "ALTER TABLE campaign_settings ADD COLUMN voucher_code TEXT NOT NULL DEFAULT ''"
            )
            if "voucher_word" in settings_columns:
                connection.execute(
                    "UPDATE campaign_settings SET voucher_code = voucher_word"
                )
            settings_columns.add("voucher_code")
        for column in ("voucher_question", "answer_salt", "answer_hash"):
            if column not in settings_columns:
                connection.execute(
                    f"ALTER TABLE campaign_settings ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                )
        connection.execute(
            "INSERT OR IGNORE INTO campaign_settings (id, max_vouchers, started_at) VALUES (1, ?, ?)",
            (initial_limit, utc_now()),
        )
        unique_code_index = None
        for index in connection.execute("PRAGMA index_list(vouchers)"):
            if not index["unique"]:
                continue
            index_name = '"' + index["name"].replace('"', '""') + '"'
            columns = [
                row["name"] for row in connection.execute(f"PRAGMA index_info({index_name})")
            ]
            if columns == ["code"]:
                unique_code_index = index["name"]
                break
        if unique_code_index:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("ALTER TABLE vouchers RENAME TO vouchers_legacy")
                connection.execute(
                    """
                    CREATE TABLE vouchers (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        code TEXT NOT NULL COLLATE NOCASE,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    "INSERT INTO vouchers (id, code, created_at) "
                    "SELECT id, code, created_at FROM vouchers_legacy"
                )
                connection.execute("DROP TABLE vouchers_legacy")
                connection.commit()
            except Exception:
                connection.rollback()
                raise


def has_voucher_challenge(settings):
    return bool(
        settings["voucher_question"]
        and settings["answer_salt"]
        and settings["answer_hash"]
    )


def is_campaign_configured(settings):
    return bool(settings["voucher_code"]) and has_voucher_challenge(settings)


def campaign_status(path=None):
    with closing(connect_database(path)) as connection:
        settings = connection.execute(
            "SELECT max_vouchers, started_at, voucher_code, voucher_question, answer_salt, answer_hash "
            "FROM campaign_settings WHERE id = 1"
        ).fetchone()
        issued = connection.execute("SELECT COUNT(*) AS count FROM vouchers").fetchone()["count"]
    return {
        "limit": settings["max_vouchers"],
        "issued": issued,
        "remaining": max(0, settings["max_vouchers"] - issued),
        "available": issued < settings["max_vouchers"],
        "challengeConfigured": is_campaign_configured(settings),
    }


def normalize_voucher_code(raw_code):
    if not isinstance(raw_code, str) or not raw_code:
        raise VoucherError(HTTPStatus.BAD_REQUEST, "invalid_code", "Enter a voucher code.")
    if len(raw_code) > MAX_VOUCHER_CODE_LENGTH:
        raise VoucherError(
            HTTPStatus.BAD_REQUEST,
            "invalid_code",
            f"Voucher codes must be {MAX_VOUCHER_CODE_LENGTH} characters or fewer.",
        )
    return raw_code


def normalize_voucher_question(raw_question):
    if not isinstance(raw_question, str) or not raw_question.strip():
        raise VoucherError(HTTPStatus.BAD_REQUEST, "invalid_question", "Enter a voucher question.")
    if len(raw_question) > MAX_VOUCHER_QUESTION_LENGTH:
        raise VoucherError(
            HTTPStatus.BAD_REQUEST,
            "invalid_question",
            f"Questions must be {MAX_VOUCHER_QUESTION_LENGTH} characters or fewer.",
        )
    return raw_question


def normalize_voucher_answer(raw_answer):
    if not isinstance(raw_answer, str) or not raw_answer.strip():
        raise VoucherError(HTTPStatus.BAD_REQUEST, "invalid_answer", "Enter an answer.")
    if len(raw_answer) > MAX_VOUCHER_ANSWER_LENGTH:
        raise VoucherError(
            HTTPStatus.BAD_REQUEST,
            "invalid_answer",
            f"Answers must be {MAX_VOUCHER_ANSWER_LENGTH} characters or fewer.",
        )
    return unicodedata.normalize("NFKC", raw_answer).strip().casefold()


def hash_voucher_answer(answer, salt):
    return hashlib.pbkdf2_hmac(
        "sha256",
        answer.encode("utf-8"),
        bytes.fromhex(salt),
        ANSWER_HASH_ITERATIONS,
    ).hex()


def get_voucher_question(raw_code, path=None):
    code = normalize_voucher_code(raw_code)
    with closing(connect_database(path)) as connection:
        settings = connection.execute(
            "SELECT max_vouchers, voucher_code, voucher_question, answer_salt, answer_hash "
            "FROM campaign_settings WHERE id = 1"
        ).fetchone()
        issued = connection.execute("SELECT COUNT(*) AS count FROM vouchers").fetchone()["count"]
    if issued >= settings["max_vouchers"]:
        raise VoucherError(
            HTTPStatus.CONFLICT,
            "unavailable",
            "this voucher is no longer available",
        )
    if not is_campaign_configured(settings):
        raise VoucherError(
            HTTPStatus.CONFLICT,
            "not_configured",
            "Voucher claims are not open yet. Please check back soon.",
        )
    if not hmac.compare_digest(code.encode("utf-8"), settings["voucher_code"].encode("utf-8")):
        raise VoucherError(
            HTTPStatus.BAD_REQUEST,
            "invalid_code",
            "That voucher code doesn't match. Please check it and try again.",
        )
    return settings["voucher_question"]


def create_voucher(raw_code, raw_answer, path=None):
    code = normalize_voucher_code(raw_code)
    answer = normalize_voucher_answer(raw_answer)

    connection = connect_database(path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        settings = connection.execute(
            "SELECT max_vouchers, voucher_code, voucher_question, answer_salt, answer_hash "
            "FROM campaign_settings WHERE id = 1"
        ).fetchone()
        issued = connection.execute("SELECT COUNT(*) AS count FROM vouchers").fetchone()["count"]
        if issued >= settings["max_vouchers"]:
            connection.rollback()
            raise VoucherError(
                HTTPStatus.CONFLICT,
                "unavailable",
                "this voucher is no longer available",
            )
        if not is_campaign_configured(settings):
            connection.rollback()
            raise VoucherError(
                HTTPStatus.CONFLICT,
                "not_configured",
                "Voucher claims are not open yet. Please check back soon.",
            )
        if not hmac.compare_digest(code.encode("utf-8"), settings["voucher_code"].encode("utf-8")):
            connection.rollback()
            raise VoucherError(
                HTTPStatus.BAD_REQUEST,
                "invalid_code",
                "That voucher code doesn't match. Please check it and try again.",
            )
        answer_hash = hash_voucher_answer(answer, settings["answer_salt"])
        if not hmac.compare_digest(answer_hash, settings["answer_hash"]):
            connection.rollback()
            raise VoucherError(
                HTTPStatus.BAD_REQUEST,
                "incorrect_answer",
                "That answer isn't correct. Please try again.",
            )
        created_at = utc_now()
        cursor = connection.execute(
            "INSERT INTO vouchers (code, created_at) VALUES (?, ?)",
            (settings["voucher_code"], created_at),
        )
        connection.commit()
        return {"id": cursor.lastrowid, "code": code, "createdAt": created_at}
    except Exception:
        if connection.in_transaction:
            connection.rollback()
        raise
    finally:
        connection.close()


def update_voucher_code(raw_code, path=None):
    code = normalize_voucher_code(raw_code)
    with closing(connect_database(path)) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute(
                "UPDATE campaign_settings SET voucher_code = ? WHERE id = 1",
                (code,),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    return code


def update_voucher_challenge(raw_question, raw_answer, path=None):
    question = normalize_voucher_question(raw_question)
    keep_existing_answer = raw_answer is None or raw_answer == ""
    answer = None if keep_existing_answer else normalize_voucher_answer(raw_answer)
    with closing(connect_database(path)) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            if keep_existing_answer:
                existing = connection.execute(
                    "SELECT answer_salt, answer_hash FROM campaign_settings WHERE id = 1"
                ).fetchone()
                if not existing["answer_salt"] or not existing["answer_hash"]:
                    connection.rollback()
                    raise VoucherError(HTTPStatus.BAD_REQUEST, "invalid_answer", "Enter an answer.")
                connection.execute(
                    "UPDATE campaign_settings SET voucher_question = ? WHERE id = 1",
                    (question,),
                )
            else:
                salt = secrets.token_bytes(16).hex()
                answer_hash = hash_voucher_answer(answer, salt)
                connection.execute(
                    "UPDATE campaign_settings "
                    "SET voucher_question = ?, answer_salt = ?, answer_hash = ? WHERE id = 1",
                    (question, salt, answer_hash),
                )
            connection.commit()
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
    return question


def update_limit(value, path=None):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_LIMIT:
        raise VoucherError(
            HTTPStatus.BAD_REQUEST,
            "invalid_limit",
            f"Choose a limit between 1 and {MAX_LIMIT:,}.",
        )

    connection = connect_database(path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        issued = connection.execute("SELECT COUNT(*) AS count FROM vouchers").fetchone()["count"]
        if value < issued:
            connection.rollback()
            raise VoucherError(
                HTTPStatus.CONFLICT,
                "limit_below_issued",
                "The limit cannot be lower than the number of vouchers already created.",
            )
        connection.execute(
            "UPDATE campaign_settings SET max_vouchers = ? WHERE id = 1",
            (value,),
        )
        connection.commit()
    except Exception:
        if connection.in_transaction:
            connection.rollback()
        raise
    finally:
        connection.close()
    return campaign_status(path)


def admin_dashboard(path=None):
    with closing(connect_database(path)) as connection:
        settings = connection.execute(
            "SELECT max_vouchers, started_at, voucher_code, voucher_question, answer_salt, answer_hash "
            "FROM campaign_settings WHERE id = 1"
        ).fetchone()
        issued = connection.execute("SELECT COUNT(*) AS count FROM vouchers").fetchone()["count"]
        first = connection.execute(
            "SELECT created_at FROM vouchers ORDER BY id ASC LIMIT 1"
        ).fetchone()
        last = connection.execute(
            "SELECT created_at FROM vouchers ORDER BY id DESC LIMIT 1"
        ).fetchone()
        recent = connection.execute(
            "SELECT code, created_at FROM vouchers ORDER BY id DESC LIMIT 8"
        ).fetchall()

    now = datetime.now(timezone.utc)
    first_time = datetime.fromisoformat(first["created_at"].replace("Z", "+00:00")) if first else None
    last_time = datetime.fromisoformat(last["created_at"].replace("Z", "+00:00")) if last else None
    started_time = datetime.fromisoformat(settings["started_at"].replace("Z", "+00:00"))
    sold_out = issued >= settings["max_vouchers"]
    elapsed = max(0, int((now - (started_time if sold_out else first_time or started_time)).total_seconds()))
    fill_seconds = max(0, int((last_time - started_time).total_seconds())) if sold_out and last_time else None
    active_seconds = max(0, int((last_time - first_time).total_seconds())) if first_time and last_time else 0
    rate = round((max(0, issued - 1) * 3600 / active_seconds), 1) if active_seconds else 0
    return {
        "limit": settings["max_vouchers"],
        "voucherCode": settings["voucher_code"],
        "voucherQuestion": settings["voucher_question"],
        "questionConfigured": has_voucher_challenge(settings),
        "challengeConfigured": is_campaign_configured(settings),
        "issued": issued,
        "remaining": max(0, settings["max_vouchers"] - issued),
        "available": not sold_out,
        "startedAt": settings["started_at"],
        "elapsedSeconds": elapsed,
        "timeToFillSeconds": fill_seconds,
        "averagePerHour": rate,
        "recent": [
            {"code": row["code"], "createdAt": row["created_at"]}
            for row in recent
        ],
    }


STATIC_ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/admin": ("admin.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/convocation-invitation.jpg": ("convocation-invitation.jpg", "image/jpeg"),
}


def should_use_secure_cookie(is_https=False):
    if os.environ.get("VOUCHER_COOKIE_SECURE") == "0":
        return False
    return COOKIE_SECURE or bool(is_https)


def make_session_cookie(is_https=False):
    expires = int(time.time()) + SESSION_LIFETIME
    value = str(expires)
    signature = hmac.new(SESSION_SECRET, value.encode("ascii"), hashlib.sha256).hexdigest()
    cookie = f"voucher_admin={value}.{signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_LIFETIME}"
    if should_use_secure_cookie(is_https):
        cookie += "; Secure"
    return cookie


def clear_session_cookie(is_https=False):
    cookie = "voucher_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    if should_use_secure_cookie(is_https):
        cookie += "; Secure"
    return cookie


def has_admin_session(cookie_header):
    cookie = SimpleCookie()
    try:
        cookie.load(cookie_header or "")
        value = cookie.get("voucher_admin")
        if not value:
            return False
        expires_text, signature = value.value.split(".", 1)
        if int(expires_text) < int(time.time()):
            return False
        expected = hmac.new(SESSION_SECRET, expires_text.encode("ascii"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected)
    except (ValueError, TypeError):
        return False


def json_response(status, payload, extra_headers=None):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Content-Length", str(len(body))),
        ("Cache-Control", "no-store"),
    ]
    if extra_headers:
        headers.extend(extra_headers)
    return int(status), headers, body


def static_response(file_name, content_type):
    content = (PUBLIC_DIR / file_name).read_bytes()
    headers = [
        ("Content-Type", content_type),
        ("Content-Length", str(len(content))),
        ("Cache-Control", "no-cache"),
    ]
    return int(HTTPStatus.OK), headers, content


def parse_json_body(content_length_header, read_bytes_fn):
    try:
        length = int(content_length_header or "0")
        if length < 1 or length > 8192:
            raise ValueError
        payload = json.loads(read_bytes_fn(length))
        if not isinstance(payload, dict):
            raise ValueError
        return payload
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        raise VoucherError(HTTPStatus.BAD_REQUEST, "invalid_json", "Please send a valid request.")


def dispatch_request(
    method,
    raw_path,
    cookie_header="",
    content_length_header="0",
    read_bytes_fn=lambda _n: b"",
    is_https=False,
    log_error_fn=None,
):
    path = urlparse(raw_path).path

    def unauthorized():
        return json_response(
            HTTPStatus.UNAUTHORIZED,
            {"error": "unauthorized", "message": "Please sign in again."},
        )

    try:
        if method in ("GET", "HEAD"):
            if path == "/api/v1/config":
                status = campaign_status()
                response = json_response(
                    HTTPStatus.OK,
                    {
                        "available": status["available"],
                        "challengeConfigured": status["challengeConfigured"],
                    },
                )
            elif path == "/api/v1/admin/dashboard":
                if not has_admin_session(cookie_header):
                    response = unauthorized()
                else:
                    response = json_response(HTTPStatus.OK, admin_dashboard())
            elif path in STATIC_ROUTES:
                file_name, content_type = STATIC_ROUTES[path]
                response = static_response(file_name, content_type)
            else:
                response = json_response(HTTPStatus.NOT_FOUND, {"error": "not_found", "message": "Not found."})
            if method == "HEAD":
                return response[0], response[1], b""
            return response

        if method == "POST":
            payload = parse_json_body(content_length_header, read_bytes_fn)
            if path == "/api/v1/vouchers":
                result = create_voucher(payload.get("code"), payload.get("answer"))
                return json_response(HTTPStatus.CREATED, {"voucher": result})
            if path == "/api/v1/voucher-question":
                question = get_voucher_question(payload.get("code"))
                return json_response(HTTPStatus.OK, {"question": question})
            if path == "/api/v1/admin/session":
                password = payload.get("password")
                if not isinstance(password, str) or not hmac.compare_digest(
                    password.encode("utf-8"),
                    ADMIN_PASSWORD.encode("utf-8"),
                ):
                    return json_response(
                        HTTPStatus.UNAUTHORIZED,
                        {"error": "invalid_credentials", "message": "That password doesn't look right. Try again."},
                    )
                return json_response(
                    HTTPStatus.OK,
                    {"authenticated": True},
                    [("Set-Cookie", make_session_cookie(is_https))],
                )
            return json_response(HTTPStatus.NOT_FOUND, {"error": "not_found", "message": "Not found."})

        if method == "PUT":
            if path not in (
                "/api/v1/admin/settings",
                "/api/v1/admin/voucher-code",
                "/api/v1/admin/voucher-challenge",
            ):
                return json_response(HTTPStatus.NOT_FOUND, {"error": "not_found", "message": "Not found."})
            if not has_admin_session(cookie_header):
                return unauthorized()
            payload = parse_json_body(content_length_header, read_bytes_fn)
            if path == "/api/v1/admin/settings":
                return json_response(HTTPStatus.OK, update_limit(payload.get("limit")))
            if path == "/api/v1/admin/voucher-code":
                return json_response(HTTPStatus.OK, {"voucherCode": update_voucher_code(payload.get("code"))})
            question = update_voucher_challenge(payload.get("question"), payload.get("answer"))
            return json_response(HTTPStatus.OK, {"voucherQuestion": question})

        if method == "DELETE":
            if path != "/api/v1/admin/session":
                return json_response(HTTPStatus.NOT_FOUND, {"error": "not_found", "message": "Not found."})
            return json_response(
                HTTPStatus.OK,
                {"authenticated": False},
                [("Set-Cookie", clear_session_cookie(is_https))],
            )

        return json_response(
            HTTPStatus.METHOD_NOT_ALLOWED,
            {"error": "method_not_allowed", "message": "Method not allowed."},
        )
    except VoucherError as error:
        return json_response(error.status, {"error": error.code, "message": error.message})
    except (OSError, sqlite3.Error):
        if log_error_fn:
            log_error_fn("%s %s failed", method, path)
        return json_response(
            HTTPStatus.INTERNAL_SERVER_ERROR,
            {"error": "server_error", "message": "Something went wrong. Please try again."},
        )


def wsgi_application(environ, start_response):
    method = environ.get("REQUEST_METHOD", "GET").upper()
    raw_path = environ.get("PATH_INFO") or "/"
    forwarded_proto = environ.get("HTTP_X_FORWARDED_PROTO", "").split(",")[0].strip().lower()
    is_https = environ.get("wsgi.url_scheme", "").lower() == "https" or forwarded_proto == "https"
    body_stream = environ.get("wsgi.input")
    status_code, headers, body = dispatch_request(
        method=method,
        raw_path=raw_path,
        cookie_header=environ.get("HTTP_COOKIE", ""),
        content_length_header=environ.get("CONTENT_LENGTH", "0"),
        read_bytes_fn=body_stream.read if body_stream else (lambda _n: b""),
        is_https=is_https,
    )
    status_phrase = HTTPStatus(status_code).phrase
    start_response(f"{status_code} {status_phrase}", headers)
    return [body]


class VoucherHandler(BaseHTTPRequestHandler):
    server_version = "VoucherApp/1.0"

    def log_message(self, format_string, *args):
        print(f"{self.address_string()} - {format_string % args}")

    def handle_dispatch(self):
        forwarded_proto = self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower()
        status_code, headers, body = dispatch_request(
            method=self.command,
            raw_path=self.path,
            cookie_header=self.headers.get("Cookie", ""),
            content_length_header=self.headers.get("Content-Length", "0"),
            read_bytes_fn=self.rfile.read,
            is_https=forwarded_proto == "https",
            log_error_fn=self.log_error,
        )
        self.send_response(status_code)
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        self.handle_dispatch()

    def do_HEAD(self):
        self.handle_dispatch()

    def do_POST(self):
        self.handle_dispatch()

    def do_PUT(self):
        self.handle_dispatch()

    def do_DELETE(self):
        self.handle_dispatch()


def resolve_bind_address():
    default_host = "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1"
    host = os.environ.get("VOUCHER_HOST") or default_host
    port = int(os.environ.get("VOUCHER_PORT") or os.environ.get("PORT") or "8000")
    return host, port


def main():
    initialize_database()
    if GENERATED_ADMIN_PASSWORD:
        print(f"Generated admin password (set VOUCHER_ADMIN_PASSWORD to keep it): {ADMIN_PASSWORD}")
    host, port = resolve_bind_address()
    server = ThreadingHTTPServer((host, port), VoucherHandler)
    print(f"Voucher app running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
