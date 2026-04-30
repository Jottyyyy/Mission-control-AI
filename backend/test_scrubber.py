"""Tests for the credential scrubber + integration.status read-action.

v1.30.4 work: catch the Mac Mini deploy session's bug where Marketing
echoed Adam's Companies House key in plain text. Two fixes verified
here:

1. Outbound scrubber masks any verbatim Keychain value before it
   reaches the user / DB log.
2. UUID-shape pattern catches credential-context UUIDs (Companies
   House issues 8-4-4-4-12 hex keys that fell under the prior
   40-char opaque-blob filter).
3. integration.status read-action returns real Keychain state so
   the agent can quote it instead of fabricating "yes already stored".

Run:
  /opt/homebrew/bin/python3.12 backend/test_scrubber.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _patch_kc(monkeypatch_map):
    """Replace _kc_get on the server module with a lookup against the
    given dict. Returns the original so the caller can restore."""
    from server import _kc_get as _original  # noqa: PLW0603
    import server
    server._kc_get = lambda tool, field: monkeypatch_map.get((tool, field))
    server._invalidate_outbound_cred_cache()
    return _original


def _restore_kc(original):
    import server
    server._kc_get = original
    server._invalidate_outbound_cred_cache()


# ---------- 1. UUID + credential-context scrubber -------------------------

def test_uuid_masked_when_credential_keyword_adjacent():
    from server import _scrub_credentials
    text = "Yes — Key: 00000000-1111-2222-3333-444444444444"
    assert "00000000" not in _scrub_credentials(text)
    assert "[redacted]" in _scrub_credentials(text)


def test_uuid_inside_sentence_masked():
    from server import _scrub_credentials
    text = "The Companies House api_key is 00000000-1111-2222-3333-444444444444 right now."
    out = _scrub_credentials(text)
    assert "00000000" not in out
    assert "[redacted]" in out


def test_uuid_in_json_blob_masked():
    from server import _scrub_credentials
    text = '{"companies_house_key": "00000000-1111-2222-3333-444444444444"}'
    out = _scrub_credentials(text)
    assert "00000000" not in out


def test_uuid_without_credential_context_left_alone():
    """A bare UUID in a sentence about job IDs / event IDs must NOT be
    masked — would break links to Calendar events and enrichment jobs."""
    from server import _scrub_credentials
    text = "Job 3a2c8f9b-1d4e-4a5f-8c2d-12345678abcd is now processing."
    out = _scrub_credentials(text)
    # No credential keyword in the window → should pass through.
    assert "3a2c8f9b" in out


def test_existing_sk_pattern_still_works():
    """Regression — pre-v1.30.4 patterns must keep working."""
    from server import _scrub_credentials
    text = "My anthropic key is sk-ant-api03-abc123def456ghi789jkl012"
    out = _scrub_credentials(text)
    assert "sk-ant" not in out


# ---------- 2. Outbound scrubber (known-stored-value) ---------------------

def test_outbound_masks_known_keychain_value():
    """If the agent echoes a value that's literally in Keychain, it
    gets replaced with '•••• stored ✅' regardless of pattern shape."""
    from server import _scrub_outbound

    fake_value = "00000000-1111-2222-3333-444444444444"
    original = _patch_kc({("companies_house", "api_key"): fake_value})
    try:
        text = f"Yes — Key: {fake_value}"
        out = _scrub_outbound(text)
        assert fake_value not in out
        assert "•••• stored ✅" in out
    finally:
        _restore_kc(original)


def test_outbound_falls_through_to_pattern_scrubber():
    """For a value that's NOT in Keychain, the outbound scrubber still
    catches credential-shaped strings via the pattern scrubber."""
    from server import _scrub_outbound

    original = _patch_kc({})
    try:
        text = "Pasted key: 00000000-1111-2222-3333-444444444444"
        out = _scrub_outbound(text)
        # Not in Keychain → falls through to _scrub_credentials → UUID
        # masked because credential keyword nearby.
        assert "00000000" not in out
    finally:
        _restore_kc(original)


def test_outbound_skips_short_keychain_values():
    """Short Keychain values (<8 chars) must NOT be added to the mask
    set — would accidentally censor ordinary words."""
    from server import _scrub_outbound

    # An OAuth-style token_expiry that's just an ISO timestamp prefix.
    original = _patch_kc({
        ("google-workspace", "token_expiry"): "2026",  # too short
        ("companies_house", "api_key"): "longenoughkey-1234567890",
    })
    try:
        text = "The year is 2026 and the meeting is at 1234567890."
        out = _scrub_outbound(text)
        # 2026 should NOT be masked (too short, not added to credential set).
        assert "2026" in out
    finally:
        _restore_kc(original)


def test_outbound_scrubs_value_even_inside_other_text():
    from server import _scrub_outbound
    fake = "abc123XYZsupersecretvalue!@#"
    original = _patch_kc({("anthropic", "api_key"): fake})
    try:
        text = f"Sure, your key starts with {fake[:5]} and the full value is {fake}."
        out = _scrub_outbound(text)
        assert fake not in out
        # The 5-char prefix preview is fine — only the full value is in
        # the mask set, and we don't substring-match.
    finally:
        _restore_kc(original)


# ---------- 3. integration.status read-action -----------------------------

def test_integration_status_unknown_id():
    from server import _read_integration_status
    text, needs_setup, needs_api = _read_integration_status({"integration": "made-up-tool"})
    assert "Unknown integration" in text
    assert needs_setup is None


def test_integration_status_missing_arg():
    from server import _read_integration_status
    text, _, _ = _read_integration_status({})
    assert "Need an `integration` id" in text


def test_integration_status_connected():
    from server import _read_integration_status
    original = _patch_kc({("companies_house", "api_key"): "fake-key-here-1234567890"})
    try:
        text, _, _ = _read_integration_status({"integration": "companies_house"})
        assert "Companies House" in text
        assert "connected" in text.lower()
        # Critical — the value MUST NOT appear in the status text.
        assert "fake-key-here-1234567890" not in text
    finally:
        _restore_kc(original)


def test_integration_status_not_connected():
    from server import _read_integration_status
    original = _patch_kc({})  # nothing stored
    try:
        text, _, _ = _read_integration_status({"integration": "companies_house"})
        assert "NOT connected" in text
        assert "api_key" in text  # tells the agent which field is missing
    finally:
        _restore_kc(original)


def test_integration_status_registered_in_handlers():
    from server import _READ_ACTION_HANDLERS
    assert "integration.status" in _READ_ACTION_HANDLERS


# ---------- Standalone runner --------------------------------------------

if __name__ == "__main__":
    fn_count = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn_count += 1
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as exc:
                print(f"FAIL  {name}: {exc}")
                sys.exit(1)
            except Exception as exc:  # noqa: BLE001
                import traceback
                print(f"ERROR {name}: {exc}")
                traceback.print_exc()
                sys.exit(2)
    print(f"\n{fn_count} tests passed.")
