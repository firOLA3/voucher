import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import ADMIN_PASSWORD, GENERATED_ADMIN_PASSWORD, initialize_database, wsgi_application

initialize_database()
if GENERATED_ADMIN_PASSWORD:
    print(f"Generated admin password (set VOUCHER_ADMIN_PASSWORD to keep it): {ADMIN_PASSWORD}")

application = wsgi_application
