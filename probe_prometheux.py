#!/usr/bin/env python3
"""Minimal Prometheux platform probe."""

from __future__ import annotations

import json
import subprocess
import sys

from prometheux_support import (
    decode_jwt_claims,
    get_jarvispy_url,
    get_platform_api_base_url,
    get_prometheux_token,
    get_usage_status,
    get_user_role,
)


def print_pretty(role_response: dict[str, object], usage_response: dict[str, object]) -> None:
    token = get_prometheux_token()
    claims = decode_jwt_claims(token)
    role_data = role_response.get("data", {}) if isinstance(role_response, dict) else {}
    usage_data = usage_response.get("data", {}) if isinstance(usage_response, dict) else {}
    llm_usage = usage_data.get("llm_usage", {}) if isinstance(usage_data, dict) else {}
    embedding_usage = usage_data.get("embedding_usage", {}) if isinstance(usage_data, dict) else {}

    print("Prometheux probe\n")
    print(f"JarvisPy URL: {get_jarvispy_url()}")
    print(f"REST API base: {get_platform_api_base_url()}")
    print(f"Organization: {claims.get('organization', 'unknown')}")
    print(f"Username: {claims.get('username', 'unknown')}")
    print(f"JWT role claim: {claims.get('role', 'unknown')}")
    print(f"Platform role: {role_data.get('role', 'unknown')}")
    print()
    print("Usage")
    print("-----")
    print(
        "LLM usage: "
        f"{llm_usage.get('current', 'n/a')} / {llm_usage.get('limit', 'n/a')} "
        f"(remaining {llm_usage.get('remaining', 'n/a')})"
    )
    print(
        "Embedding usage: "
        f"{embedding_usage.get('current', 'n/a')} / {embedding_usage.get('limit', 'n/a')} "
        f"(remaining {embedding_usage.get('remaining', 'n/a')})"
    )


def main(argv: list[str]) -> int:
    raw = "--raw" in argv
    token = get_prometheux_token()

    if not token:
        print("Missing PMTX_TOKEN environment variable.", file=sys.stderr)
        print("Example: export PMTX_TOKEN='eyJ...'", file=sys.stderr)
        return 1

    if not get_jarvispy_url():
        print("Missing JARVISPY_URL and could not derive it from PMTX_TOKEN.", file=sys.stderr)
        return 2

    try:
        role_response = get_user_role()
        usage_response = get_usage_status()
    except subprocess.CalledProcessError as exc:
        print("Prometheux HTTP error.", file=sys.stderr)
        if exc.stdout:
            print(exc.stdout, file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        return 3
    except Exception as exc:  # noqa: BLE001
        print(f"Prometheux probe failed: {exc}", file=sys.stderr)
        return 4

    if raw:
        print(
            json.dumps(
                {
                    "claims": decode_jwt_claims(token),
                    "jarvispy_url": get_jarvispy_url(),
                    "api_base_url": get_platform_api_base_url(),
                    "role_response": role_response,
                    "usage_response": usage_response,
                },
                indent=2,
            )
        )
    else:
        print_pretty(role_response, usage_response)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
