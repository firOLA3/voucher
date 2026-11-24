import json
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import (
    VoucherError,
    VoucherHandler,
    admin_dashboard,
    campaign_status,
    create_voucher,
    get_voucher_question,
    initialize_database,
    resolve_bind_address,
    update_limit,
    update_voucher_challenge,
    update_voucher_code,
)


class VoucherDatabaseTests(unittest.TestCase):
    SHARED_CODE = " GRAD/2026 🎓 "
    QUESTION = "What year is the convocation?"
    ANSWER = "Class of 2026"

    def setUp(self):
        iterations_patch = patch("server.ANSWER_HASH_ITERATIONS", 1000)
        iterations_patch.start()
        self.addCleanup(iterations_patch.stop)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "vouchers.sqlite3"
        initialize_database(self.database, initial_limit=3)
        update_voucher_code(self.SHARED_CODE, self.database)
        update_voucher_challenge(self.QUESTION, self.ANSWER, self.database)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_claim_preserves_admin_configured_code_exactly(self):
        voucher = create_voucher(self.SHARED_CODE, self.ANSWER, self.database)

        self.assertEqual(voucher["code"], self.SHARED_CODE)
        self.assertEqual(campaign_status(self.database), {
            "limit": 3,
            "issued": 1,
            "remaining": 2,
            "available": True,
            "challengeConfigured": True,
        })

    def test_shared_code_can_be_claimed_multiple_times(self):
        first = create_voucher(self.SHARED_CODE, self.ANSWER, self.database)
        second = create_voucher(self.SHARED_CODE, self.ANSWER, self.database)

        self.assertEqual(first["code"], second["code"])
        self.assertEqual(campaign_status(self.database)["issued"], 2)

    def test_wrong_code_is_rejected(self):
        with self.assertRaises(VoucherError) as caught:
            create_voucher("OTHER-CODE", self.ANSWER, self.database)

        self.assertEqual(caught.exception.code, "invalid_code")

    def test_admin_can_set_arbitrary_shared_voucher_code(self):
        result = update_voucher_code("  spring / 2026 🎓  ", self.database)

        self.assertEqual(result, "  spring / 2026 🎓  ")
        self.assertEqual(admin_dashboard(self.database)["voucherCode"], result)

    def test_correct_voucher_code_reveals_question_not_answer(self):
        self.assertEqual(get_voucher_question(self.SHARED_CODE, self.database), self.QUESTION)
        self.assertNotIn("answer", admin_dashboard(self.database))

    def test_wrong_answer_does_not_create_voucher(self):
        with self.assertRaises(VoucherError) as caught:
            create_voucher(self.SHARED_CODE, "wrong answer", self.database)

        self.assertEqual(caught.exception.code, "incorrect_answer")
        self.assertEqual(campaign_status(self.database)["issued"], 0)

    def test_answer_matching_ignores_case_and_outer_whitespace(self):
        voucher = create_voucher(self.SHARED_CODE, "  cLASS OF 2026  ", self.database)

        self.assertEqual(voucher["code"], self.SHARED_CODE)

    def test_admin_can_change_voucher_question_and_answer(self):
        question = "Which faculty is celebrating?"
        update_voucher_challenge(question, "Nursing", self.database)

        self.assertEqual(get_voucher_question(self.SHARED_CODE, self.database), question)
        with self.assertRaises(VoucherError):
            create_voucher(self.SHARED_CODE, self.ANSWER, self.database)
        self.assertEqual(create_voucher(self.SHARED_CODE, "Nursing", self.database)["code"], self.SHARED_CODE)

    def test_claims_require_admin_to_configure_question_and_answer(self):
        database = Path(self.temp_dir.name) / "unconfigured.sqlite3"
        initialize_database(database, initial_limit=3)
        update_voucher_code(self.SHARED_CODE, database)

        with self.assertRaises(VoucherError) as caught:
            create_voucher(self.SHARED_CODE, self.ANSWER, database)

        self.assertEqual(caught.exception.code, "not_configured")
        self.assertFalse(campaign_status(database)["challengeConfigured"])

    def test_global_limit_is_enforced_for_simultaneous_requests(self):
        lock = threading.Lock()
        created = []
        failures = []

        def claim(index):
            try:
                result = create_voucher(self.SHARED_CODE, self.ANSWER, self.database)
                with lock:
                    created.append(result)
            except VoucherError as error:
                with lock:
                    failures.append(error.code)

        with ThreadPoolExecutor(max_workers=12) as pool:
            list(pool.map(claim, range(12)))

        self.assertEqual(len(created), 3)
        self.assertEqual(failures.count("unavailable"), 9)
        self.assertEqual(campaign_status(self.database)["issued"], 3)

    def test_admin_cannot_lower_limit_below_issued_count(self):
        create_voucher(self.SHARED_CODE, self.ANSWER, self.database)
        create_voucher(self.SHARED_CODE, self.ANSWER, self.database)

        with self.assertRaises(VoucherError) as caught:
            update_limit(1, self.database)

        self.assertEqual(caught.exception.code, "limit_below_issued")
        self.assertEqual(campaign_status(self.database)["limit"], 3)

    def test_existing_database_migrates_to_allow_shared_word_claims(self):
        database = Path(self.temp_dir.name) / "legacy.sqlite3"
        with closing(sqlite3.connect(database)) as connection:
            connection.executescript(
                """
                CREATE TABLE campaign_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    max_vouchers INTEGER NOT NULL CHECK (max_vouchers > 0),
                    started_at TEXT NOT NULL
                );
                CREATE TABLE vouchers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    created_at TEXT NOT NULL
                );
                INSERT INTO campaign_settings VALUES (1, 4, '2026-11-24T00:00:00Z');
                INSERT INTO vouchers (code, created_at) VALUES ('OLD-CODE', '2026-11-24T00:00:01Z');
                """
            )

        initialize_database(database)
        update_voucher_code(self.SHARED_CODE, database)
        update_voucher_challenge(self.QUESTION, self.ANSWER, database)
        create_voucher(self.SHARED_CODE, self.ANSWER, database)
        create_voucher(self.SHARED_CODE, self.ANSWER, database)

        self.assertEqual(campaign_status(database)["issued"], 3)

    def test_existing_voucher_word_setting_migrates_without_changing_code(self):
        database = Path(self.temp_dir.name) / "old-word-setting.sqlite3"
        with closing(sqlite3.connect(database)) as connection:
            connection.executescript(
                """
                CREATE TABLE campaign_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    max_vouchers INTEGER NOT NULL CHECK (max_vouchers > 0),
                    started_at TEXT NOT NULL,
                    voucher_word TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE vouchers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT NOT NULL COLLATE NOCASE,
                    created_at TEXT NOT NULL
                );
                INSERT INTO campaign_settings VALUES
                    (1, 4, '2026-11-24T00:00:00Z', ' R&D 🎓 2026 ');
                """
            )

        initialize_database(database)
        update_voucher_challenge(self.QUESTION, self.ANSWER, database)

        self.assertEqual(admin_dashboard(database)["voucherCode"], " R&D 🎓 2026 ")
        create_voucher(" R&D 🎓 2026 ", self.ANSWER, database)
        self.assertEqual(campaign_status(database)["issued"], 1)

    def test_dashboard_reports_question_configured_separately_from_full_challenge(self):
        database = Path(self.temp_dir.name) / "question-only.sqlite3"
        initialize_database(database, initial_limit=3)
        update_voucher_challenge(self.QUESTION, self.ANSWER, database)

        dashboard = admin_dashboard(database)
        self.assertTrue(dashboard["questionConfigured"])
        self.assertFalse(dashboard["challengeConfigured"])
        self.assertEqual(dashboard["voucherQuestion"], self.QUESTION)

    def test_admin_can_update_question_while_preserving_existing_answer(self):
        updated_question = "Which graduating class is celebrating?"
        update_voucher_challenge(updated_question, "", self.database)

        self.assertEqual(get_voucher_question(self.SHARED_CODE, self.database), updated_question)
        with self.assertRaises(VoucherError):
            create_voucher(self.SHARED_CODE, "wrong", self.database)
        voucher = create_voucher(self.SHARED_CODE, self.ANSWER, self.database)
        self.assertEqual(voucher["code"], self.SHARED_CODE)

    def test_blank_answer_is_rejected_when_no_answer_is_configured_yet(self):
        database = Path(self.temp_dir.name) / "missing-answer.sqlite3"
        initialize_database(database, initial_limit=3)

        with self.assertRaises(VoucherError) as caught:
            update_voucher_challenge(self.QUESTION, "", database)

        self.assertEqual(caught.exception.code, "invalid_answer")

    def test_get_voucher_question_rejects_wrong_code_and_sold_out_campaign(self):
        with self.assertRaises(VoucherError) as wrong_code:
            get_voucher_question("WRONG", self.database)
        self.assertEqual(wrong_code.exception.code, "invalid_code")

        for _ in range(3):
            create_voucher(self.SHARED_CODE, self.ANSWER, self.database)

        with self.assertRaises(VoucherError) as sold_out:
            get_voucher_question(self.SHARED_CODE, self.database)
        self.assertEqual(sold_out.exception.code, "unavailable")
        self.assertEqual(sold_out.exception.message, "this voucher is no longer available")


class PublicApiTests(unittest.TestCase):
    def setUp(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), VoucherHandler)
        self.server_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.server_thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.server_thread.join()

    def test_public_config_only_exposes_availability(self):
        with patch(
            "server.campaign_status",
            return_value={
                "available": True,
                "challengeConfigured": True,
                "limit": 3,
                "issued": 1,
                "remaining": 2,
            },
        ):
            with urlopen(f"{self.base_url}/api/v1/config") as response:
                body = json.loads(response.read())

        self.assertEqual(body, {"available": True, "challengeConfigured": True})

    def test_public_claim_response_does_not_expose_campaign_totals(self):
        voucher = {"id": 1, "code": "CLASS-26", "createdAt": "2026-11-24T16:00:00Z"}
        request = Request(
            f"{self.base_url}/api/v1/vouchers",
            data=json.dumps({"code": "CLASS-26"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with patch("server.create_voucher", return_value=voucher):
            with urlopen(request) as response:
                body = json.loads(response.read())

        self.assertEqual(body, {"voucher": voucher})

    def test_public_question_endpoint_returns_only_the_question(self):
        question = "Which faculty is celebrating?"
        request = Request(
            f"{self.base_url}/api/v1/voucher-question",
            data=json.dumps({"code": "CLASS-26"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with patch("server.get_voucher_question", return_value=question):
            with urlopen(request) as response:
                body = json.loads(response.read())

        self.assertEqual(body, {"question": question})


class EndToEndHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "e2e.sqlite3"
        initialize_database(self.database, initial_limit=2)
        self.patches = [
            patch("server.DATABASE_PATH", self.database),
            patch("server.ANSWER_HASH_ITERATIONS", 1000),
            patch("server.ADMIN_PASSWORD", "test-admin-secret"),
        ]
        for active_patch in self.patches:
            active_patch.start()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), VoucherHandler)
        self.server_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.server_thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.server_thread.join()
        for active_patch in reversed(self.patches):
            active_patch.stop()
        self.temp_dir.cleanup()

    def api_call(self, method, path, payload=None, cookie=None):
        headers = {}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")
        if cookie:
            headers["Cookie"] = cookie
        request = Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urlopen(request) as response:
                return response.status, json.loads(response.read()), response.headers
        except HTTPError as error:
            with error:
                return error.code, json.loads(error.read()), error.headers

    def test_full_admin_setup_and_visitor_question_claim_flow(self):
        for static_path in ("/", "/admin", "/styles.css", "/app.js"):
            with urlopen(f"{self.base_url}{static_path}") as response:
                self.assertEqual(response.status, 200)

        status, body, _ = self.api_call("GET", "/api/v1/admin/dashboard")
        self.assertEqual(status, 401)

        status, _, _ = self.api_call("POST", "/api/v1/admin/session", {"password": "wrong"})
        self.assertEqual(status, 401)

        status, body, headers = self.api_call(
            "POST", "/api/v1/admin/session", {"password": "test-admin-secret"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["authenticated"])
        cookie = headers.get("Set-Cookie").split(";", 1)[0]

        status, body, _ = self.api_call("PUT", "/api/v1/admin/settings", {"limit": 1}, cookie)
        self.assertEqual(status, 200)
        self.assertEqual(body["limit"], 1)

        status, body, _ = self.api_call(
            "PUT", "/api/v1/admin/voucher-code", {"code": "NURSING-26"}, cookie
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["voucherCode"], "NURSING-26")

        status, body, _ = self.api_call(
            "PUT",
            "/api/v1/admin/voucher-challenge",
            {"question": "What month is induction?", "answer": "November"},
            cookie,
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["voucherQuestion"], "What month is induction?")
        self.assertNotIn("answer", body)

        status, body, _ = self.api_call(
            "PUT",
            "/api/v1/admin/voucher-challenge",
            {"question": "Which month is the ceremony?", "answer": ""},
            cookie,
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["voucherQuestion"], "Which month is the ceremony?")

        status, dashboard, _ = self.api_call("GET", "/api/v1/admin/dashboard", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertTrue(dashboard["questionConfigured"])
        self.assertTrue(dashboard["challengeConfigured"])
        self.assertNotIn("answer", dashboard)

        status, config, _ = self.api_call("GET", "/api/v1/config")
        self.assertEqual(status, 200)
        self.assertEqual(config, {"available": True, "challengeConfigured": True})

        status, err, _ = self.api_call("POST", "/api/v1/voucher-question", {"code": "WRONG"})
        self.assertEqual(status, 400)
        self.assertEqual(err["error"], "invalid_code")

        status, q_body, _ = self.api_call("POST", "/api/v1/voucher-question", {"code": "NURSING-26"})
        self.assertEqual(status, 200)
        self.assertEqual(q_body, {"question": "Which month is the ceremony?"})

        status, err, _ = self.api_call(
            "POST", "/api/v1/vouchers", {"code": "NURSING-26", "answer": "December"}
        )
        self.assertEqual(status, 400)
        self.assertEqual(err["error"], "incorrect_answer")

        status, claim, _ = self.api_call(
            "POST", "/api/v1/vouchers", {"code": "NURSING-26", "answer": "  november "}
        )
        self.assertEqual(status, 201)
        self.assertEqual(claim["voucher"]["code"], "NURSING-26")

        status, sold_out, _ = self.api_call("POST", "/api/v1/voucher-question", {"code": "NURSING-26"})
        self.assertEqual(status, 409)
        self.assertEqual(sold_out["message"], "this voucher is no longer available")

        status, _, _ = self.api_call("DELETE", "/api/v1/admin/session", cookie=cookie)
        self.assertEqual(status, 200)

    def test_resolve_bind_address_supports_local_and_render_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve_bind_address(), ("127.0.0.1", 8000))
        with patch.dict(os.environ, {"RENDER": "true", "PORT": "10000"}, clear=True):
            self.assertEqual(resolve_bind_address(), ("0.0.0.0", 10000))
        with patch.dict(
            os.environ,
            {"RENDER": "true", "PORT": "10000", "VOUCHER_HOST": "127.0.0.1", "VOUCHER_PORT": "9000"},
            clear=True,
        ):
            self.assertEqual(resolve_bind_address(), ("127.0.0.1", 9000))


if __name__ == "__main__":
    unittest.main()
