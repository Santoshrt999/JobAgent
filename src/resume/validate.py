"""Resume format + content validation.

Before a tailored resume is attached to an application, we verify it is actually
a usable document — not empty, not malformed, and containing the sections a
recruiter expects. This is a HONEST quality gate: it inspects the generated
``.docx`` and reports problems; it never edits the resume or invents content.

Checks performed:
  * the file exists and opens as a valid .docx
  * it has a reasonable amount of text (not blank, not truncated)
  * it contains contact details (an email and/or phone number), in the body, a
    page header or footer, or a text box
  * it has the core sections (experience, education, skills)
  * how many of the job's target keywords are actually present (coverage)

Returns a structured verdict; ``ok`` is False only for hard problems (unreadable,
empty, or missing every core section / all contact info) so the pipeline can flag
those as blockers while treating softer issues (e.g. one missing section, low
keyword coverage) as warnings.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Iterable, List

from keywordAudit import audit_keywords, read_docx_contact_text, read_docx_text

# Section header synonyms we look for (case-insensitive, word-ish match).
SECTION_PATTERNS: Dict[str, List[str]] = {
    "experience": ["experience", "employment", "work history", "professional background"],
    "education": ["education", "academic"],
    "skills": ["skills", "technical skills", "core competencies", "technologies"],
}

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Phone: at least 10 digits, allowing +, spaces, dashes, parentheses, dots.
PHONE_RE = re.compile(r"(?:\+?\d[\s().-]?){10,}")

MIN_WORDS = 150
MAX_WORDS = 1400


def _word_count(text: str) -> int:
    return len([w for w in re.split(r"\s+", text.strip()) if w])


def _find_sections(text: str) -> Dict[str, bool]:
    low = text.lower()
    found: Dict[str, bool] = {}
    for section, synonyms in SECTION_PATTERNS.items():
        found[section] = any(s in low for s in synonyms)
    return found


def validate_resume(
    resume_path: str | Path,
    keywords: Iterable[str] | None = None,
    *,
    min_words: int = MIN_WORDS,
    max_words: int = MAX_WORDS,
) -> Dict[str, Any]:
    """Validate the generated resume's format + content.

    Returns ``{ok, issues, warnings, sections, word_count, has_email,
    has_phone, keyword_coverage}``. Never raises for a bad/missing file — that is
    reported as an issue with ``ok=False``.
    """
    keywords = list(keywords or [])
    resume_path = Path(resume_path)
    result: Dict[str, Any] = {
        "ok": False,
        "issues": [],
        "warnings": [],
        "sections": {k: False for k in SECTION_PATTERNS},
        "word_count": 0,
        "has_email": False,
        "has_phone": False,
        "keyword_coverage": {"present": [], "missing": [], "ratio": 0.0},
    }

    if not resume_path.exists():
        result["issues"].append(f"resume file not found: {resume_path}")
        return result

    try:
        text = read_docx_text(resume_path)
    except Exception as err:  # noqa: BLE001 - report any read/parse failure
        result["issues"].append(f"could not read resume: {type(err).__name__}: {err}")
        return result

    words = _word_count(text)
    result["word_count"] = words
    if words == 0:
        result["issues"].append("resume is empty (no extractable text)")
        return result
    if words < min_words:
        result["warnings"].append(f"resume looks short ({words} words; expected >= {min_words})")
    if words > max_words:
        result["warnings"].append(f"resume looks long ({words} words; expected <= {max_words})")

    sections = _find_sections(text)
    result["sections"] = sections
    missing_sections = [s for s, present in sections.items() if not present]
    if len(missing_sections) == len(sections):
        result["issues"].append("resume is missing all core sections (experience/education/skills)")
    elif missing_sections:
        result["warnings"].append(f"resume is missing section(s): {', '.join(missing_sections)}")

    # The contact line usually lives in the page header, which the body text never
    # includes. A header that cannot be read must not turn into "no contact".
    try:
        contact_text = f"{text}\n{read_docx_contact_text(resume_path)}"
    except Exception:  # noqa: BLE001 - fall back to the body, as before
        contact_text = text
    result["has_email"] = bool(EMAIL_RE.search(contact_text))
    result["has_phone"] = bool(PHONE_RE.search(contact_text))
    if not result["has_email"] and not result["has_phone"]:
        result["issues"].append("resume has no contact details (no email or phone found)")
    elif not result["has_email"]:
        result["warnings"].append("resume has no email address")

    if keywords:
        audit = audit_keywords(text, keywords)
        total = len(audit["present"]) + len(audit["missing"])
        ratio = (len(audit["present"]) / total) if total else 0.0
        result["keyword_coverage"] = {
            "present": audit["present"],
            "missing": audit["missing"],
            "ratio": round(ratio, 3),
        }
        if total and ratio < 0.4:
            result["warnings"].append(
                f"low keyword coverage ({int(ratio * 100)}%): "
                f"missing {', '.join(audit['missing'][:8])}"
            )

    result["ok"] = len(result["issues"]) == 0
    return result
