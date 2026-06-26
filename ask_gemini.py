#!/usr/bin/env python3
"""Minimal Gemini REST probe for generic market/event follow-up questions."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

from search_tavily import ENV_PATH, load_dotenv

DEFAULT_MODEL = "gemini-3.5-flash"
DEFAULT_FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"]
DEFAULT_PROMPT = (
    "Summarize whether recent news flow is bullish or bearish for NVDA in 4 "
    "short bullet points."
)


def get_api_key() -> str:
    return (
        os.environ.get("GEMINI_API_KEY", "").strip()
        or os.environ.get("GOOGLE_API_KEY", "").strip()
    )


def get_model() -> str:
    return os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL


def get_model_candidates(model: str | None = None) -> list[str]:
    """Return preferred Gemini models in retry order."""
    requested = (model or get_model()).strip() or DEFAULT_MODEL
    env_fallbacks = [
        item.strip()
        for item in os.environ.get("GEMINI_FALLBACK_MODELS", "").split(",")
        if item.strip()
    ]
    fallbacks = env_fallbacks or DEFAULT_FALLBACK_MODELS

    candidates: list[str] = []
    for candidate in [requested, *fallbacks]:
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    return candidates


def build_payload(prompt: str) -> dict[str, object]:
    return {
        "contents": [
            {
                "parts": [
                    {
                        "text": prompt,
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
        },
    }


def should_retry_on_model_fallback(exc: subprocess.CalledProcessError) -> bool:
    """Retry smaller models only for transient/quota style failures."""
    details = f"{exc.stdout}\n{exc.stderr}".lower()
    retry_markers = [
        "quota",
        "429",
        "resource_exhausted",
        "overloaded",
        "503",
        "unavailable",
        "rate limit",
    ]
    return any(marker in details for marker in retry_markers)


def call_gemini_once(api_key: str, prompt: str, model_name: str) -> dict[str, object]:
    """Call a single Gemini model once."""
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model_name}:generateContent"
    )
    payload = build_payload(prompt)

    result = subprocess.run(
        [
            "curl",
            "--fail-with-body",
            "-sS",
            url,
            "-H",
            f"x-goog-api-key: {api_key}",
            "-H",
            "Content-Type: application/json",
            "-d",
            json.dumps(payload),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    data = json.loads(result.stdout)
    if isinstance(data, dict):
        data["_model_used"] = model_name
    return data


def call_gemini(api_key: str, prompt: str, model: str | None = None) -> dict[str, object]:
    """Call Gemini with automatic fallback to smaller models when appropriate."""
    last_error: subprocess.CalledProcessError | None = None

    for model_name in get_model_candidates(model):
        try:
            return call_gemini_once(api_key, prompt, model_name)
        except subprocess.CalledProcessError as exc:
            last_error = exc
            if should_retry_on_model_fallback(exc):
                continue
            raise

    if last_error is not None:
        raise last_error
    raise RuntimeError("No Gemini models available to try.")


def extract_text(data: dict[str, object]) -> str:
    candidates = data.get("candidates", [])
    if not isinstance(candidates, list):
        return ""

    parts_text: list[str] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content", {})
        if not isinstance(content, dict):
            continue
        parts = content.get("parts", [])
        if not isinstance(parts, list):
            continue
        for part in parts:
            if isinstance(part, dict) and "text" in part:
                parts_text.append(str(part["text"]))

    return "\n".join(text.strip() for text in parts_text if text).strip()


def parse_args(argv: list[str]) -> tuple[bool, str]:
    raw = False
    parts: list[str] = []

    for arg in argv:
        if arg == "--raw":
            raw = True
        else:
            parts.append(arg)

    prompt = " ".join(parts).strip() or DEFAULT_PROMPT
    return raw, prompt


def main(argv: list[str]) -> int:
    load_dotenv(ENV_PATH)
    raw, prompt = parse_args(argv)
    api_key = get_api_key()

    if not api_key:
        print("Missing GEMINI_API_KEY or GOOGLE_API_KEY.", file=sys.stderr)
        print(
            "Create or copy it from AI Studio and add it to .env.",
            file=sys.stderr,
        )
        return 1

    try:
        data = call_gemini(api_key, prompt)
    except subprocess.CalledProcessError as exc:
        print("Gemini API error:", file=sys.stderr)
        if exc.stdout:
            print(exc.stdout, file=sys.stderr)
        print(exc.stderr, file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired:
        print("Gemini request timed out.", file=sys.stderr)
        return 3

    if raw:
        print(json.dumps(data, indent=2))
        return 0

    text = extract_text(data)
    if text:
        model_used = data.get("_model_used")
        if isinstance(model_used, str) and model_used:
            print(f"Model used: {model_used}")
        print(textwrap.fill(text, width=90))
        return 0

    print("Gemini returned no text output.", file=sys.stderr)
    print(json.dumps(data, indent=2), file=sys.stderr)
    return 4


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
