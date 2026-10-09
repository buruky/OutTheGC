"""
Connectivity smoke test for the OpenAI account/key used in step 11.

This is NOT the real extraction script -- it sends one minimal request to
confirm that:
  - OPENAI_API_KEY in .env is valid
  - the account's free-tier quota actually allows a live API call
  - the gpt-5.4-mini model is reachable on this account

Safe to delete once services/worker's real extraction script exists and has
made its first successful call.

Usage:
    python test_openai_connection.py
"""

import os
import sys

from dotenv import load_dotenv

MODEL = "gpt-5.4-mini"


def main() -> int:
    load_dotenv()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print(
            "FAILED: OPENAI_API_KEY is not set.\n"
            "Check that services/worker/.env exists and defines OPENAI_API_KEY."
        )
        return 1

    # Import here so a missing dependency gives a clear message instead of a
    # traceback at the top of the file.
    try:
        from openai import (
            APIConnectionError,
            AuthenticationError,
            NotFoundError,
            OpenAI,
            PermissionDeniedError,
            RateLimitError,
        )
    except ImportError:
        print(
            "FAILED: the 'openai' package is not installed.\n"
            "Run: pip install -r requirements.txt"
        )
        return 1

    client = OpenAI(api_key=api_key)

    print(f"Sending a minimal test request to model '{MODEL}'...")

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Reply with exactly this JSON and nothing else: "
                        '{"status": "ok"}'
                    ),
                }
            ],
            max_completion_tokens=20,
        )
    except AuthenticationError as e:
        print(
            "FAILED (401 AuthenticationError): the API key is invalid, "
            "malformed, or revoked. Double-check OPENAI_API_KEY in .env "
            "is the exact key from the OpenAI dashboard.\n"
            f"Detail: {_safe_detail(e)}"
        )
        return 1
    except RateLimitError as e:
        # The OpenAI SDK raises RateLimitError for BOTH "too many requests
        # right now" (RPM/RPD exceeded) AND "insufficient_quota" (no billing
        # / quota exhausted) -- the error body distinguishes them.
        detail = _safe_detail(e)
        if "insufficient_quota" in detail.lower() or "quota" in detail.lower():
            print(
                "FAILED (429, insufficient quota): the key is valid but "
                "this account has no usable quota for this model right now "
                "-- this is the billing/free-tier-exhausted case, not a "
                "transient rate limit.\n"
                f"Detail: {detail}"
            )
        else:
            print(
                "FAILED (429, rate limited): the key and quota look fine, "
                "but the request rate (RPM/RPD) was exceeded. Wait and "
                "retry rather than treating this as a dead key.\n"
                f"Detail: {detail}"
            )
        return 1
    except (NotFoundError, PermissionDeniedError) as e:
        print(
            f"FAILED: model '{MODEL}' is not available to this account/tier "
            "(the dashboard can list a model without every account actually "
            "having call access to it).\n"
            f"Detail: {_safe_detail(e)}"
        )
        return 1
    except APIConnectionError as e:
        print(
            "FAILED: could not reach the OpenAI API (network issue, not a "
            "key/quota/model problem).\n"
            f"Detail: {_safe_detail(e)}"
        )
        return 1
    except Exception as e:
        print(
            "FAILED: unexpected error (not one of the anticipated 401 / "
            "quota / rate-limit / model-not-found cases).\n"
            f"Detail: {_safe_detail(e)}"
        )
        return 1

    content = response.choices[0].message.content
    usage = response.usage
    print("SUCCESS: received a response from the API.")
    print(f"Model replied: {content!r}")
    if usage is not None:
        print(
            f"Token usage -- prompt: {usage.prompt_tokens}, "
            f"completion: {usage.completion_tokens}, "
            f"total: {usage.total_tokens}"
        )
    return 0


def _safe_detail(exc: Exception) -> str:
    """Stringify an SDK exception without ever including the API key."""
    text = str(exc)
    # Defense in depth: the SDK shouldn't echo the key back, but never let
    # the literal key value reach stdout/logs if it somehow did.
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if api_key and api_key in text:
        text = text.replace(api_key, "<redacted>")
    return text


if __name__ == "__main__":
    sys.exit(main())
