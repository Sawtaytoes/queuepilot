"""Resolve the soundtrack for the last-played movie/show → a control_media command.

Living-Room-reader easter egg: scanning the same kids card downstairs plays the
soundtrack of whatever was last put on the theater. Three tiers, cheapest first:

  1. Music Assistant library  — search MA for a matching soundtrack album/artist.
  2. YouTube Music            — fall back to a YTM search command string.
  3. Ollama (gemma)           — as a last resort, ask the LLM to name the actual
                                soundtrack album/composer, then YTM-search that.

Returns {command_string, tier, query} where `command_string` is what HA hands to
`script.control_media` (grammar: "Media <Type>: <Name> [by <Artist>]").

NOTE: this is Phase 4 (deferred to hands-on verification). The MA search endpoint
and control_media's exact YTM command grammar must be confirmed live; the tiers are
structured so tuning is localized. It never raises — worst case it returns a plain
YTM search string so the downstairs card always does *something*.
"""
import json
import ssl
import urllib.parse
import urllib.request

from . import config

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


def _http_json(url, method="GET", headers=None, data=None, timeout=30):
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
        return json.loads(r.read().decode() or "{}")


# --- Tier 1: Music Assistant library ------------------------------------- #
def _ma_library_match(title):
    """Best-effort MA library search for a soundtrack album. None if unavailable.

    TODO(verify live): confirm MA's search endpoint/shape behind the reverse proxy.
    """
    if not config.MA_URL:
        return None
    try:
        q = urllib.parse.urlencode({"search": f"{title} soundtrack", "media_type": "album"})
        headers = {"Accept": "application/json"}
        if config.MA_TOKEN:
            headers["Authorization"] = f"Bearer {config.MA_TOKEN}"
        data = _http_json(f"{config.MA_URL.rstrip('/')}/api/search?{q}", headers=headers)
        albums = (data or {}).get("albums") or []
        if albums:
            a = albums[0]
            name = a.get("name") or a.get("title")
            artist = (a.get("artists") or [{}])[0].get("name") if a.get("artists") else None
            return f"Media Album: {name}" + (f" by {artist}" if artist else "")
    except Exception:
        return None
    return None


# --- Tier 3: Ollama names the actual soundtrack --------------------------- #
def _ollama_guess(title, media_type):
    """Ask gemma for the real soundtrack album/composer. None if unavailable."""
    if not config.OLLAMA_URL:
        return None
    prompt = (
        f"The {media_type} \"{title}\" — give ONLY the exact title of its official "
        f"soundtrack album and the composer/artist, as: <album> — <artist>. "
        f"No explanation."
    )
    try:
        body = json.dumps({"model": config.OLLAMA_MODEL, "prompt": prompt, "stream": False}).encode()
        data = _http_json(
            f"{config.OLLAMA_URL.rstrip('/')}/api/generate", method="POST",
            headers={"Content-Type": "application/json"}, data=body, timeout=60,
        )
        text = (data or {}).get("response", "").strip().splitlines()
        return text[0].strip() if text else None
    except Exception:
        return None


def resolve(title, media_type="movie"):
    """Resolve `title` → a control_media command string, trying each tier."""
    if not title:
        return {"command_string": "", "tier": "none", "query": ""}

    # Tier 1 — local MA library.
    hit = _ma_library_match(title)
    if hit:
        return {"command_string": hit, "tier": "ma-library", "query": title}

    # Tier 3 — let the LLM name the actual OST, then YTM-search that.
    guess = _ollama_guess(title, media_type)
    query = guess or f"{title} soundtrack"

    # Tier 2 — YouTube Music search fallback (always yields something).
    # TODO(verify live): confirm control_media's YTM search command grammar.
    return {"command_string": f"Media Search: {query}", "tier": "ytmusic" if not guess else "ollama+ytmusic",
            "query": query}
