#!/usr/bin/env python3
"""Small Prometheux Platform API helper."""

from __future__ import annotations

import base64
import binascii
import json
import os
import subprocess
from typing import Any

from search_tavily import ENV_PATH, load_dotenv

PROMETHEUX_HOST = "https://api.prometheux.ai"


def get_prometheux_token() -> str:
    """Load the Prometheux bearer token from environment."""
    load_dotenv(ENV_PATH)
    return os.environ.get("PMTX_TOKEN", "").strip()


def decode_jwt_claims(token: str) -> dict[str, Any]:
    """Decode JWT claims without verifying the signature."""
    parts = token.split(".")
    if len(parts) < 2:
        return {}

    payload = parts[1]
    payload += "=" * (-len(payload) % 4)

    try:
        raw = base64.urlsafe_b64decode(payload.encode("ascii"))
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error):
        return {}

    return data if isinstance(data, dict) else {}


def derive_jarvispy_url(token: str) -> str:
    """Build the documented JarvisPy base URL from JWT claims."""
    claims = decode_jwt_claims(token)
    organization = str(claims.get("organization", "")).strip()
    username = str(claims.get("username", "")).strip()

    if not organization or not username:
        return ""
    return f"{PROMETHEUX_HOST}/jarvispy/{organization}/{username}"


def normalize_jarvispy_url(value: str) -> str:
    """Normalize configured SDK base URLs and reject the root host placeholder."""
    normalized = value.strip().rstrip("/")
    if normalized.endswith("/api/v1"):
        normalized = normalized[: -len("/api/v1")]
    if not normalized or normalized == PROMETHEUX_HOST:
        return ""
    return normalized


def get_jarvispy_url() -> str:
    """Resolve the JarvisPy SDK base URL from env or token claims."""
    load_dotenv(ENV_PATH)
    configured = normalize_jarvispy_url(os.environ.get("JARVISPY_URL", ""))
    if configured:
        return configured

    derived = derive_jarvispy_url(get_prometheux_token())
    if derived:
        os.environ["JARVISPY_URL"] = derived
    return derived


def get_platform_api_base_url() -> str:
    """Return the documented REST API base URL."""
    jarvispy_url = get_jarvispy_url()
    if not jarvispy_url:
        return ""
    return f"{jarvispy_url}/api/v1"


def has_prometheux_config() -> bool:
    """Return whether Prometheux is configured well enough for API calls."""
    return bool(get_prometheux_token() and get_platform_api_base_url())


def run_prometheux_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Call the Prometheux Platform REST API using curl."""
    api_base_url = get_platform_api_base_url()
    token = get_prometheux_token()

    if not token:
        raise RuntimeError("Missing PMTX_TOKEN.")
    if not api_base_url:
        raise RuntimeError("Missing JARVISPY_URL and could not derive it from PMTX_TOKEN.")

    request_path = path if path.startswith("/") else f"/{path}"
    command = [
        "curl",
        "--fail-with-body",
        "-sS",
        "-X",
        method.upper(),
        f"{api_base_url}{request_path}",
        "-H",
        f"Authorization: Bearer {token}",
    ]

    if body is not None:
        command.extend(
            [
                "-H",
                "Content-Type: application/json",
                "-d",
                json.dumps(body),
            ]
        )

    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return json.loads(result.stdout)


def is_no_active_compute_error(exc: subprocess.CalledProcessError) -> bool:
    """Return whether Prometheux rejected a request due to missing compute."""
    details = f"{exc.stdout}\n{exc.stderr}".lower()
    return "no_active_compute" in details or "no active compute resources" in details


def evaluate_vadalog_program(
    program: str,
    compute: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Submit a Vadalog program to the platform reasoning engine."""
    body: dict[str, Any] = {"program": program}
    if compute:
        body["compute"] = compute
    return run_prometheux_request("POST", "/vadalog/evaluate", body)


def get_vadalog_status() -> dict[str, Any]:
    """Return the live Vadalog engine status."""
    return run_prometheux_request("GET", "/vadalog/status")


def get_user_role() -> dict[str, Any]:
    """Fetch the current Prometheux role for the configured token."""
    return run_prometheux_request("GET", "/users/get-role")


def get_usage_status() -> dict[str, Any]:
    """Fetch current Prometheux usage statistics."""
    return run_prometheux_request("GET", "/users/usage-status")
