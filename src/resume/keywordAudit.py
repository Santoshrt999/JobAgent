"""Resume keyword audit.

Reads the master resume (.docx) and reports which job keywords are already
present and which are missing. Used to (a) surface honest tailoring gaps and
(b) feed the deterministic resume tailor. It never invents skills.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Sequence


def read_docx_text(path: str | Path) -> str:
    """Extract all text (paragraphs + tables) from a .docx file."""
    from docx import Document  # imported lazily so non-docx tests still run

    document = Document(str(path))
    parts: List[str] = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                parts.append(cell.text)
    return "\n".join(parts)


def _paragraph_texts(paragraphs) -> List[str]:
    """Text of each ``w:p``, from its own runs only.

    A text box holds its own nested paragraphs, so reading only a paragraph's
    direct runs keeps each line once, whether it sits in the page or in a box.
    """
    lines: List[str] = []
    for paragraph in paragraphs:
        runs = paragraph.xpath("./w:r/w:t | ./w:hyperlink/w:r/w:t")
        line = "".join(node.text or "" for node in runs)
        if line.strip():
            lines.append(line)
    return lines


def read_docx_contact_text(path: str | Path) -> str:
    """Text from the places a resume keeps its contact line besides the body.

    Page headers and footers (every section, first-page and even-page variants)
    and text boxes. Word puts a name, email and phone in the page header so they
    repeat on every page, and python-docx's ``document.paragraphs`` never sees
    it, so a resume with its contact line there looked like it had none
    (measured 2026-11-13). Used for the contact check only, so keyword coverage,
    word count and section detection still read the body alone.
    """
    from docx import Document  # imported lazily so non-docx tests still run

    document = Document(str(path))
    lines: List[str] = []
    for section in document.sections:
        for part in (
            section.header, section.first_page_header, section.even_page_header,
            section.footer, section.first_page_footer, section.even_page_footer,
        ):
            # A part linked to the previous section holds nothing of its own, and
            # reading it would only repeat that section's text.
            if part.is_linked_to_previous:
                continue
            lines.extend(_paragraph_texts(part._element.xpath(".//w:p")))
    lines.extend(_paragraph_texts(document.element.body.xpath(".//w:txbxContent//w:p")))
    return "\n".join(lines)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower()).strip()


def _phrase_pattern(phrase: str) -> re.Pattern:
    """Boundary-aware matcher so short skills do not match inside other words."""
    escaped = re.escape(_normalize(phrase))
    return re.compile(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])", re.IGNORECASE)


def _evidence_terms(
    keyword: str,
    evidence_aliases: Mapping[str, Sequence[str]] | None,
) -> List[str]:
    aliases = {
        _normalize(term): list(values or [])
        for term, values in (evidence_aliases or {}).items()
    }
    result: List[str] = []
    seen = set()
    for term in [keyword, *aliases.get(_normalize(keyword), [])]:
        key = _normalize(term)
        if key and key not in seen:
            seen.add(key)
            result.append(str(term))
    return result


def audit_keywords(
    resume_text: str,
    keywords: Iterable[str],
    *,
    evidence_aliases: Mapping[str, Sequence[str]] | None = None,
) -> Dict[str, List[str]]:
    """Split ``keywords`` into those present vs. missing in ``resume_text``.

    Matching is case-insensitive and boundary-aware. Configured evidence aliases
    can support a JD term (for example, PySpark supports Spark) without claiming
    that genuinely absent technologies are present.
    """
    haystack = _normalize(resume_text)
    present: List[str] = []
    missing: List[str] = []
    seen = set()
    for kw in keywords:
        key = _normalize(kw)
        if not key or key in seen:
            continue
        seen.add(key)
        supported = any(
            _phrase_pattern(term).search(haystack)
            for term in _evidence_terms(str(kw), evidence_aliases)
        )
        (present if supported else missing).append(kw)
    return {"present": present, "missing": missing}


def audit_resume(resume_path: str | Path, keywords: Iterable[str]) -> Dict[str, List[str]]:
    """Convenience wrapper: read the resume then audit keywords."""
    return audit_keywords(read_docx_text(resume_path), keywords)
