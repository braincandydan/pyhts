"""Extract and normalize HTS codes from training records."""

from __future__ import annotations

import json
import re
from typing import Any

# 10-digit tariff lines, 6-digit, 4-digit heading
HTS_FULL = re.compile(r"\b(\d{4}\.\d{2}\.\d{4})\b")
HTS_6 = re.compile(r"\b(\d{4}\.\d{2}\.\d{2})\b")
HTS_4 = re.compile(r"\b(\d{4}\.\d{2})\b")
HTS_LOOSE = re.compile(r"\b(\d{4}\.\d{2}(?:\.\d{0,4})?)\b")
HTS_ARROW = re.compile(r"HTS\s+(?:US\s+)?Code\s*->\s*([^;\n]+)", re.IGNORECASE)
PRODUCT_RE = re.compile(
    r"Product:\s*(.+?)(?:\n\n|\nAvailable|\Z)", re.DOTALL | re.IGNORECASE
)


def normalize_code(raw: str) -> str | None:
    code = raw.strip().rstrip(".")
    parts = code.split(".")
    if len(parts) < 2:
        return None
    if len(parts[0]) != 4 or not parts[0].isdigit():
        return None
    if len(parts[1]) != 2 or not parts[1].isdigit():
        return None
    if len(parts) == 2:
        return f"{parts[0]}.{parts[1]}"
    suffix = parts[2]
    if not suffix.isdigit() or len(suffix) < 2:
        return None
    return f"{parts[0]}.{parts[1]}.{suffix[:4]}"


def codes_from_text(text: str) -> set[str]:
    found: set[str] = set()
    if not text:
        return found
    for pattern in (HTS_FULL, HTS_6, HTS_4, HTS_LOOSE):
        for raw in pattern.findall(text):
            norm = normalize_code(raw)
            if norm:
                found.add(norm)
    return found


def walk_json(value: Any, found: set[str]) -> None:
    if isinstance(value, str):
        found.update(codes_from_text(value))
    elif isinstance(value, dict):
        for v in value.values():
            walk_json(v, found)
    elif isinstance(value, list):
        for item in value:
            walk_json(item, found)


def parse_tool_arguments(args: Any) -> Any:
    if isinstance(args, dict):
        return args
    if isinstance(args, str) and args.strip():
        try:
            return json.loads(args)
        except json.JSONDecodeError:
            return args
    return args


def extract_product(messages: list[dict]) -> str:
    for msg in messages:
        if msg.get("role") != "user":
            continue
        content = (msg.get("content") or "").strip()
        m = PRODUCT_RE.search(content)
        if m:
            return " ".join(m.group(1).split())[:200]
        if content:
            return content[:200]
    return ""


def extract_primary_codes(row: dict) -> list[str]:
    """Codes from classification path (assistant/tool), not chapter menus."""
    found: set[str] = set()
    for msg in row.get("messages", []):
        role = msg.get("role")
        if role not in ("assistant", "tool"):
            continue
        content = msg.get("content") or ""
        found.update(codes_from_text(content))
        for match in HTS_ARROW.finditer(content):
            found.update(codes_from_text(match.group(1)))
        if role == "assistant":
            for tc in msg.get("tool_calls") or []:
                fn = tc.get("function") or {}
                walk_json(parse_tool_arguments(fn.get("arguments")), found)
    return sorted(found)


def extract_all_codes(row: dict) -> list[str]:
    """All codes anywhere in the record (incl. headings mentioned in reasoning)."""
    found = codes_from_text(json.dumps(row, ensure_ascii=False))
    for msg in row.get("messages", []):
        if msg.get("role") == "assistant":
            for match in HTS_ARROW.finditer(msg.get("content") or ""):
                found.update(codes_from_text(match.group(1)))
    return sorted(found)


def extract_codes(row: dict) -> tuple[list[str], list[str]]:
    primary = extract_primary_codes(row)
    all_codes = extract_all_codes(row)
    if not primary:
        primary = all_codes
    return primary, all_codes


def is_code_query(query: str) -> bool:
    q = query.strip()
    return bool(q) and sum(c.isdigit() for c in q) >= max(2, len(q) // 2)


def parse_text_query(query: str) -> tuple[str, bool]:
    """
    Parse a text search query.
    Returns (term, whole_word).
    - Quoted "sign" -> whole word
    - Plain sign -> whole word (avoids design, assign, …)
    - Prefix *sign -> substring (sign anywhere)
    """
    q = query.strip()
    if not q:
        return "", True
    if len(q) >= 2 and q[0] == q[-1] and q[0] in "\"'":
        return q[1:-1].strip().lower(), True
    if q.startswith("*"):
        return q[1:].strip().lower(), False
    if is_code_query(q):
        return q.lower(), False
    return q.lower(), True


def text_matches(search_text: str, query: str, match_mode: str = "auto") -> bool:
    term, whole_word = parse_text_query(query)
    if match_mode == "word":
        whole_word = True
    elif match_mode == "substr":
        whole_word = False
    if not term:
        return True
    text = (search_text or "").lower()
    if whole_word:
        return bool(re.search(rf"\b{re.escape(term)}\b", text))
    return term in text


def extract_search_text(messages: list[dict]) -> str:
    """
    Text for product/question search.
    Includes user question and assistant/tool replies (where items like
    'warning sign' appear in classification reasoning).
    Skips system prompts and agent chapter menus.
    """
    parts: list[str] = []
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            continue
        content = (msg.get("content") or "").strip()
        if not content:
            continue
        if role == "user":
            if "Available chapters" in content:
                product = extract_product(messages)
                if product:
                    parts.append(product)
                continue
            m = PRODUCT_RE.search(content)
            if m:
                parts.append(" ".join(m.group(1).split()))
            else:
                parts.append(content[:800])
        elif role in ("assistant", "tool"):
            parts.append(content[:6000])
    return " ".join(parts).lower()
