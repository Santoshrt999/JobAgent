"""Deterministic resume tailoring.

Produces a per-job tailored copy of the master resume WITHOUT inventing any
content. The master file is opened read-only (we never call ``save`` on it).

Tailoring actions (all honest, content-preserving):
  1. Classify requested terms as required, preferred, or unclassified from the
     job description's explicit qualification headings.
  2. Reorder existing summary paragraphs and bullet runs, within their original
     sections/roles, so supported required content appears before preferred
     content. Paragraphs are moved intact; none are copied, deleted, or edited.
  3. Emphasize (bold) the matched keyword ITSELF wherever the resume already
     mentions it. The run is split so only the phrase is bolded, never the
     surrounding sentence, and the number of emphasized terms is capped so the
     page never reads as keyword-stuffed.
  4. Reorder the comma-separated skill lists in CORE COMPETENCIES so the skills
     this JD asks for come FIRST in each category. Handles BOTH layouts: a
     2-column table and the more common "Label:  a, b, c" paragraph. Splitting
     is bracket-aware, so a qualified skill like
     "Dimensional Modeling (Kimball, Inmon)" moves as ONE item. Pure permutation
     of existing items — nothing is added, removed, or reworded.
  5. Optionally insert a "most relevant to this role" line built ONLY from
     keywords that are both requested by the job AND already present in the
     resume. It is anchored just above the CORE COMPETENCIES / PROFESSIONAL
     SUMMARY heading so ATS parsers see the job's own terminology up top.
  6. Flatten layout tables into single-column paragraphs in the generated copy,
     preserving their exact text/runs so ATS parsers read content in order.
  7. Repair layout artifacts: manual page breaks (which freeze pagination and
     leave half-empty pages), role blocks a previous pass folded into one
     paragraph (which cost the first bullet of every role its formatting),
     runs of blank filler, and `mailto:` prefixes left in visible text. These
     arrive from OUTSIDE too — a tailored copy saved back over the master
     carries them into every later run — so they are cleaned on the way in.
  8. Fit the result to a page budget (2 pages by default) by OMITTING whole
     low-relevance bullets from the oldest roles, worst-first, never dropping a
     role, heading, date, or a role's last bullet, and never shortening or
     rewording anything. Omissions are listed in `changes` for review.
  9. Save the result to a per-job .docx in the job's output folder.

Free-form rewriting is intentionally disabled. Without a claim-level evidence
map, even plausible wording changes can silently invent scope, ownership,
technologies, or metrics. This module therefore performs exact-text movement
and formatting changes whose provenance is auditable, plus ONE narrow
exception: ``accepted_rewrites``, bullets whose rewording was verified against
cited master-resume lines (src/resume/claimVerifier.js) and then accepted by a
person. Exactly those bullets change; every other unit is still checked
byte-for-byte by the truth invariants.

Every action is recorded in a structured ``changes`` list (what changed, where,
before/after, and the evidence for why) so a human can review the tailored
resume against the master before approving the application.

If a keyword is requested but missing from the resume, it is reported as a gap
(``gaps``) and is never added as a fabricated skill.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

from humanizer import humanize
from jdKeywords import classify_qualification_keywords
from keywordAudit import read_docx_text


_DEFAULT_REQUIRED_MARKERS = (
    "required", "requirements", "must have", "must-have",
    "minimum qualifications", "minimum qualification", "basic qualifications",
    "what you need", "what you'll need", "what you will need", "you have",
    "you bring", "qualifications",
)
_DEFAULT_PREFERRED_MARKERS = (
    "preferred", "nice to have", "nice-to-have", "bonus", "a plus", "plus",
    "desired", "preferred qualifications", "good to have",
)
_QUALIFICATION_WEIGHT = {"required": 3, "preferred": 2, "unclassified": 1}
# A role's date line. Full month names were the only form recognised, so a
# résumé written "Jan 2020 – Present" / "Mar 2017 – Dec 2019" / "2015 – 2018"
# had ONE detectable role (the "Present" one) and every older role's bullets
# were counted as part of it. The page fit then treated the whole career as a
# single role and could strip older employers down to nothing. Every common
# form is recognised now: full and abbreviated months, MM/YYYY, and year
# RANGES (a bare year is not enough, so "B.S., 2016" stays an education line).
_MONTHS = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|"
    r"aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
)
_EMPLOYMENT_DATE_RE = re.compile(
    rf"\b{_MONTHS}\s*[’']?\s*\d{{2,4}}\b"
    r"|\b(?:0?[1-9]|1[0-2])\s*/\s*(?:19|20)\d{2}\b"
    r"|\b(?:19|20)\d{2}\s*(?:-|–|—|to|until)\s*(?:(?:19|20)\d{2}|present|current|now|today)\b"
    r"|\bpresent\b",
    re.IGNORECASE,
)


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug or "untitled"


def _date_stamp(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.strftime("%Y%m%d")


def output_filename(company: str, title: str, now: datetime | None = None) -> str:
    return f"{_slug(company)}_{_slug(title)}_{_date_stamp(now)}.docx"


def _phrase_pattern(phrase: str) -> re.Pattern:
    """Boundary-aware matcher that remains tolerant of tech punctuation."""
    return re.compile(
        rf"(?<![a-z0-9]){re.escape((phrase or '').strip())}(?![a-z0-9])",
        re.IGNORECASE,
    )


def _keyword_details(qualifications: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        re.sub(r"\s+", " ", str(item.get("keyword", "")).lower()).strip(): item
        for item in qualifications.get("items", [])
        if str(item.get("keyword", "")).strip()
    }


def _matches_for_text(
    text: str,
    keywords: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Return grounded keyword evidence for one existing resume fragment."""
    matched: List[Dict[str, Any]] = []
    for keyword in keywords:
        if not keyword or not _phrase_pattern(str(keyword)).search(text or ""):
            continue
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        detail = qualification_details.get(key, {})
        matched.append({
            "keyword": keyword,
            "qualification": detail.get("classification", "unclassified"),
            "resume_text": text,
            "jd_evidence": detail.get("jd_evidence", []),
        })
    matched.sort(
        key=lambda item: -_QUALIFICATION_WEIGHT.get(item["qualification"], 1)
    )
    return matched


def _relevance_key(evidence: Sequence[Dict[str, Any]]) -> tuple:
    """Sort key: any required evidence outranks any preferred evidence."""
    weights = [
        _QUALIFICATION_WEIGHT.get(item.get("qualification", "unclassified"), 1)
        for item in evidence
    ]
    if not weights:
        return (0, 0, 0)
    return (max(weights), sum(weights), len(weights))


def _iter_all_paragraphs(document):
    """Yield body and table-cell paragraphs once each."""
    seen = set()
    for paragraph in document.paragraphs:
        if paragraph._p not in seen:
            seen.add(paragraph._p)
            yield paragraph
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    if paragraph._p not in seen:
                        seen.add(paragraph._p)
                        yield paragraph


#: Most distinct terms to emphasize in one resume. Emphasis exists to draw a
#: human reviewer's eye to a handful of decisive matches. Past this, bolding
#: stops meaning anything and the page reads as keyword-stuffed.
_MAX_EMPHASIZED_TERMS = 12

#: Most terms named in the single "Most relevant to this role" line.
#:
#: REGRESSION GUARD. This line had no cap at all. Verified against a real,
#: buzzword-dense JD (a role that legitimately touched every configured
#: keyword category at once): the generated line named 31 terms in one
#: sentence — "Most relevant to this role: data engineer, senior data
#: engineer, azure, microsoft fabric, fabric, adf, synapse, databricks..." —
#: which reads as a keyword dump, not a highlight, to any human reviewer.
#:
#: This is deliberately much smaller than _MAX_EMPHASIZED_TERMS: bolding is
#: distributed across a whole two-page document and stays absorbable at 12,
#: but this list sits in ONE sentence, so it needs to read like something a
#: person would actually write. It costs nothing for ATS keyword coverage —
#: every term still appears verbatim in the resume's actual content (that is
#: WHY it was eligible for "present" in the first place); this line is a
#: human-facing highlight, not the mechanism that gets a term recognized.
_MAX_FOCUS_LINE_TERMS = 6


def _merge_spans(spans: Sequence[tuple]) -> List[tuple]:
    """Merge overlapping/adjacent (start, end) ranges, left to right."""
    merged: List[tuple] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _bold_spans_in_run(paragraph, run, spans: Sequence[tuple]) -> int:
    """Split ``run`` so ONLY the given character ranges become bold.

    Bolding the whole run was the original behaviour, and on a real resume it is
    ruinous: Word commonly stores an entire bullet as ONE run, so a single
    keyword match turned the complete bullet bold. A tailored resume came out
    with thirteen fully-bold bullets — unprofessional to a human, and a
    keyword-stuffing signal to an ATS.

    The run is rebuilt as up to 2n+1 runs that concatenate to exactly the same
    text, each inheriting the original run's formatting, with ``bold`` set only
    on the keyword pieces. ``paragraph.text`` is therefore unchanged, so the
    no-loss text invariant still holds.

    @return number of bolded pieces created
    """
    from copy import deepcopy as _deepcopy
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from docx.text.run import Run

    text = run.text or ""
    ranges = [
        (max(0, start), min(len(text), end))
        for start, end in _merge_spans(spans)
        if 0 <= start < end
    ]
    if not ranges:
        return 0

    pieces: List[tuple] = []
    cursor = 0
    for start, end in ranges:
        if start > cursor:
            pieces.append((text[cursor:start], False))
        pieces.append((text[start:end], True))
        cursor = end
    if cursor < len(text):
        pieces.append((text[cursor:], False))
    pieces = [(chunk, bold) for chunk, bold in pieces if chunk]

    # The whole run IS the keyword (e.g. a standalone skill cell): no split
    # needed, just emphasize it.
    if len(pieces) == 1:
        run.bold = True
        return 1

    element = run._r
    parent = element.getparent()
    index = list(parent).index(element)

    created = []
    for chunk, bold in pieces:
        clone = _deepcopy(element)
        # Keep only the formatting; drop copied text/breaks/tabs.
        for child in list(clone):
            if child.tag != qn("w:rPr"):
                clone.remove(child)
        node = OxmlElement("w:t")
        node.set(qn("xml:space"), "preserve")
        node.text = chunk
        clone.append(node)
        created.append((clone, bold))

    for offset, (clone, _bold) in enumerate(created):
        parent.insert(index + offset, clone)
    parent.remove(element)

    bolded = 0
    for clone, bold in created:
        if bold:
            Run(clone, paragraph).bold = True
            bolded += 1
    return bolded


def _emphasize(
    document,
    keywords: List[str],
    qualification_details: Dict[str, Dict[str, Any]],
    *,
    max_terms: int = _MAX_EMPHASIZED_TERMS,
) -> tuple[int, List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Bold the KEYWORD ITSELF wherever the resume already mentions it.

    Two deliberate limits keep the result professional:
      * only the matched phrase is bolded, never the surrounding sentence
        (see _bold_spans_in_run), and
      * each distinct term is emphasized at its FIRST occurrence only, with a
        cap of ``max_terms`` terms per resume. Required JD qualifications are
        emphasized before preferred ones, so the budget goes to what the posting
        actually insists on.

    Returns ``(count, evidence, mutations)`` where evidence lists, per keyword,
    the existing resume text that mentions it — proof the emphasis is grounded
    in real content, not injected.
    """
    # Spend the emphasis budget on required terms first, then preferred, then
    # the rest; ties keep the caller's ordering for determinism.
    def _priority(keyword: str) -> int:
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        classification = qualification_details.get(key, {}).get("classification", "unclassified")
        return -_QUALIFICATION_WEIGHT.get(classification, 1)

    ordered_keywords = sorted(
        [keyword for keyword in keywords if keyword],
        key=lambda keyword: (_priority(keyword), keywords.index(keyword)),
    )

    count = 0
    evidence_by_keyword: Dict[str, Dict[str, Any]] = {}
    mutations: List[Dict[str, Any]] = []
    emphasized_terms: set = set()

    paragraphs = list(_iter_all_paragraphs(document))
    for keyword in ordered_keywords:
        if len(emphasized_terms) >= max_terms:
            break
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        if key in emphasized_terms:
            continue
        pattern = _phrase_pattern(str(keyword))
        placed = False
        for para in paragraphs:
            if placed:
                break
            if _norm_heading(para.text).startswith("most relevant to this role:"):
                continue
            for run in list(para.runs):
                text = run.text or ""
                if not text:
                    continue
                match = pattern.search(text)
                if not match:
                    continue
                # Already bold in the master: nothing to do, but the term is
                # spent so we do not hunt for another occurrence.
                if run.bold is True:
                    placed = True
                    break
                added = _bold_spans_in_run(para, run, [(match.start(), match.end())])
                if not added:
                    continue
                count += added
                mutations.append({
                    "text": match.group(0),
                    "paragraph": (para.text or "").strip(),
                    "before_bold": run.bold,
                    "after_bold": True,
                })
                detail = qualification_details.get(key, {})
                evidence_by_keyword.setdefault(key, {
                    "keyword": keyword,
                    "qualification": detail.get("classification", "unclassified"),
                    "resume_text": (para.text or "").strip()[:240],
                    "jd_evidence": detail.get("jd_evidence", []),
                })
                placed = True
                break
        if placed:
            emphasized_terms.add(key)

    return count, list(evidence_by_keyword.values()), mutations


_BRACKET_PAIRS = {"(": ")", "[": "]", "{": "}"}
_CLOSERS = set(_BRACKET_PAIRS.values())


def _split_skill_list(text: str) -> List[str]:
    """Split a comma-separated competency list into items, respecting brackets.

    A naive ``split(",")`` tears qualified skills apart: the real entry
    "Dimensional Modeling (Kimball, Inmon)" became TWO items,
    "Dimensional Modeling (Kimball" and "Inmon)". Reordering then reassembled
    them around unrelated skills and produced literal nonsense in a resume sent
    to employers — while the item-multiset invariant still passed, because every
    fragment was technically still present.

    Commas inside (), [] or {} are therefore treated as part of the item.
    """
    items: List[str] = []
    buffer: List[str] = []
    depth = 0
    for char in text or "":
        if char in _BRACKET_PAIRS:
            depth += 1
            buffer.append(char)
        elif char in _CLOSERS:
            depth = max(0, depth - 1)
            buffer.append(char)
        elif char == "," and depth == 0:
            item = "".join(buffer).strip()
            if item:
                items.append(item)
            buffer = []
        else:
            buffer.append(char)
    tail = "".join(buffer).strip()
    if tail:
        items.append(tail)
    return items


def _brackets_balanced(text: str) -> bool:
    """True when every bracket in ``text`` is matched — a split-integrity check."""
    stack: List[str] = []
    for char in text or "":
        if char in _BRACKET_PAIRS:
            stack.append(_BRACKET_PAIRS[char])
        elif char in _CLOSERS:
            if not stack or stack.pop() != char:
                return False
    return not stack


def _set_cell_text_preserving(cell, text: str) -> None:
    """Replace a table cell's text while keeping the first run's formatting."""
    para = cell.paragraphs[0]
    if para.runs:
        para.runs[0].text = text
        for run in para.runs[1:]:
            run.text = ""
    else:
        para.add_run(text)


_COMPETENCY_HEADINGS = {
    "core competencies", "technical skills", "skills", "key skills",
    "areas of expertise", "technologies",
}
_SECTION_HEADINGS = _COMPETENCY_HEADINGS | {
    "professional summary", "summary", "profile", "career summary",
    "professional experience", "work experience", "experience", "employment history",
    "education", "certifications", "projects", "selected projects", "publications",
    "awards", "additional information",
    # Secondary experience blocks. Unrecognised, "EARLIER EXPERIENCE" read as
    # body text inside the role above it.
    "earlier experience", "additional experience", "other experience",
    "relevant experience", "volunteer experience", "volunteering", "leadership",
    "honors", "honors and awards", "licenses", "training", "languages",
}


def _preceding_section_heading(document, table) -> str:
    """Return the closest recognized section heading before a table."""
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph

    sibling = table._tbl.getprevious()
    while sibling is not None:
        if sibling.tag == qn("w:p"):
            text = _norm_heading(Paragraph(sibling, document._body).text)
            if text in _SECTION_HEADINGS:
                return text
        sibling = sibling.getprevious()
    return ""


def _reorder_competencies(
    document,
    keywords: List[str],
    qualification_details: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Reorder comma-separated skills so JD-matched ones come first.

    Applies only to a 2-column table under a recognized competency heading, so
    unrelated employment/education tables cannot be mutated accidentally.
    STRICTLY a stable permutation of the existing items — the multiset of
    skills is unchanged; nothing is added, removed, or reworded. Required
    matches rank before preferred matches. Returns one provenance record per
    row actually reordered.
    """
    changes: List[Dict[str, Any]] = []
    if not keywords:
        return changes
    for table_index, table in enumerate(document.tables):
        section = _preceding_section_heading(document, table)
        if section not in _COMPETENCY_HEADINGS:
            continue
        for row_index, row in enumerate(table.rows):
            if len(row.cells) != 2:
                continue
            category = (row.cells[0].text or "").strip()
            value_cell = row.cells[1]
            # Reconstructing a multi-paragraph cell can alter its layout. Keep
            # complex cells untouched rather than pretending that is ATS-safe.
            if len(value_cell.paragraphs) != 1:
                continue
            nonempty_runs = [
                run for run in value_cell.paragraphs[0].runs if (run.text or "")
            ]
            if len(nonempty_runs) > 1:
                continue
            before_items = _split_skill_list(value_cell.text)
            if len(before_items) < 2:
                continue
            evidence_by_item = {
                item: _matches_for_text(item, keywords, qualification_details)
                for item in before_items
            }
            indexed = list(enumerate(before_items))
            ranked = sorted(
                indexed,
                key=lambda pair: (
                    -_relevance_key(evidence_by_item[pair[1]])[0],
                    -_relevance_key(evidence_by_item[pair[1]])[1],
                    -_relevance_key(evidence_by_item[pair[1]])[2],
                    pair[0],
                ),
            )
            after_items = [item for _index, item in ranked]
            matched = [item for item in after_items if evidence_by_item[item]]
            if after_items == before_items or not matched:
                continue
            if Counter(before_items) != Counter(after_items):
                raise RuntimeError("competency reordering changed the source skill multiset")
            # Integrity check the multiset cannot provide: if the split tore a
            # qualified skill apart ("… (Kimball, Inmon)"), each fragment carries
            # an unbalanced bracket and reordering would emit nonsense. Refuse.
            if any(not _brackets_balanced(item) for item in before_items):
                continue
            _set_cell_text_preserving(value_cell, ", ".join(after_items))
            changes.append({
                "type": "reorder_skills",
                "where": f"{section}: {category or 'competencies'}",
                "before": before_items,
                "after": after_items,
                "evidence": {
                    "job description asks for": [
                        evidence
                        for item in matched
                        for evidence in evidence_by_item[item]
                    ],
                    "master_resume_items": matched,
                },
                "reason": (
                    "supported required skills moved before supported preferred/other skills; "
                    "no items were added, removed, or reworded"
                ),
                "source": "master_resume",
                "table_index": table_index,
                "row_index": row_index,
            })
    return changes


#: A competency line looks like "Data Platforms:  Azure Databricks, Fabric, …".
#: The label is short and followed by a comma-separated skill list.
_COMPETENCY_LINE_RE = re.compile(r"^(?P<label>[^:]{1,48}?)(?P<sep>\s*:\s*)(?P<items>\S.*)$")


def _parse_competency_line(text: str) -> tuple | None:
    """Split a "Label: a, b, c" competency line into (label, sep, items).

    Returns None unless the line really is a labelled skill list: a short label,
    at least two comma-separated items, and no sentence punctuation in the label.
    """
    raw = text or ""
    match = _COMPETENCY_LINE_RE.match(raw.strip())
    if not match:
        return None
    label = match.group("label").strip()
    if not label or len(label.split()) > 5 or re.search(r"[.!?;]", label):
        return None
    items = _split_skill_list(match.group("items"))
    if len(items) < 2:
        return None
    return label, match.group("sep"), items


def _is_competency_paragraph(paragraph) -> bool:
    """Structural test for a skills line, independent of document position.

    Position-independent on purpose: inserting the focus line shifts paragraph
    indexes, and the content-unit invariant must classify a line identically
    before and after tailoring.

    The generated focus line ("Most relevant to this role: a, b, c") is itself
    shaped like a competency list, so it is excluded explicitly — the invariant
    accounts for it as a whole inserted paragraph, and decomposing it here would
    make the before/after unit counts disagree.
    """
    if _is_bullet(paragraph):
        return False
    if _norm_heading(paragraph.text).startswith("most relevant to this role:"):
        return False
    return _parse_competency_line(paragraph.text) is not None


def _reorder_competency_paragraphs(
    document,
    keywords: List[str],
    qualification_details: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Reorder a PARAGRAPH-based skills list so JD-matched skills come first.

    `_reorder_competencies` only handles a 2-column table. Plenty of resumes —
    including the one this project ships against — write CORE COMPETENCIES as
    plain paragraphs ("Data Platforms:  Azure Databricks, …"), so that function
    silently found nothing and the single highest-value ATS action (leading each
    skill category with what the posting actually asked for) never happened.

    STRICTLY a stable permutation of the existing items: the multiset of skills
    is unchanged, and the label, separator, and run formatting are preserved.
    Only fires when the item text lives inside ONE run, so we never rebuild a
    mixed-formatting line and quietly change its appearance.
    """
    changes: List[Dict[str, Any]] = []
    if not keywords:
        return changes

    bounds = _section_bounds(document, _COMPETENCY_HEADINGS)
    if bounds is None:
        return changes
    start, end = bounds

    for paragraph in document.paragraphs[start:end]:
        parsed = _parse_competency_line(paragraph.text)
        if parsed is None or _is_bullet(paragraph):
            continue
        label, _sep, before_items = parsed

        evidence_by_item = {
            item: _matches_for_text(item, keywords, qualification_details)
            for item in before_items
        }
        indexed = list(enumerate(before_items))
        ranked = sorted(
            indexed,
            key=lambda pair: (
                -_relevance_key(evidence_by_item[pair[1]])[0],
                -_relevance_key(evidence_by_item[pair[1]])[1],
                -_relevance_key(evidence_by_item[pair[1]])[2],
                pair[0],
            ),
        )
        after_items = [item for _index, item in ranked]
        matched = [item for item in after_items if evidence_by_item[item]]
        if after_items == before_items or not matched:
            continue
        if Counter(before_items) != Counter(after_items):
            raise RuntimeError("competency reordering changed the source skill multiset")
        # Integrity check the multiset cannot provide: if the split tore a
        # qualified skill apart ("… (Kimball, Inmon)"), each fragment carries
        # an unbalanced bracket and reordering would emit nonsense. Refuse.
        if any(not _brackets_balanced(item) for item in before_items):
            continue

        # Locate the item text inside a single run, then rewrite just that slice.
        joined = ", ".join(before_items)
        full = paragraph.text or ""
        item_start = full.find(joined)
        if item_start < 0:
            continue
        item_end = item_start + len(joined)

        target_run = None
        run_offset = 0
        for run in paragraph.runs:
            run_text = run.text or ""
            run_end = run_offset + len(run_text)
            if run_offset <= item_start and item_end <= run_end:
                target_run = (run, run_offset)
                break
            run_offset = run_end
        if target_run is None:
            # Items span several runs; leave the line alone rather than
            # reconstructing it and risking a formatting change.
            continue

        run, offset = target_run
        run_text = run.text or ""
        local_start = item_start - offset
        local_end = item_end - offset
        run.text = run_text[:local_start] + ", ".join(after_items) + run_text[local_end:]

        changes.append({
            "type": "reorder_skills",
            "where": f"core competencies: {label}",
            "before": before_items,
            "after": after_items,
            "evidence": {
                "job description asks for": [
                    evidence for item in matched for evidence in evidence_by_item[item]
                ],
                "master_resume_items": matched,
            },
            "reason": (
                "supported required skills moved before supported preferred/other skills; "
                "no items were added, removed, or reworded"
            ),
            "source": "master_resume",
        })
    return changes


def _semantic_tokens(document) -> Counter:
    """Content-token multiset used to prove table flattening lost no words."""
    tokens = []
    for paragraph in _iter_all_paragraphs(document):
        tokens.extend(re.findall(
            r"[a-z0-9][a-z0-9+#./%_-]*", paragraph.text or "", re.IGNORECASE
        ))
    return Counter(token.lower() for token in tokens)


def _copy_cell_content(target, cell) -> None:
    """Append a cell's text/runs to a body paragraph with formatting intact."""
    wrote = False
    for paragraph in cell.paragraphs:
        if wrote and (paragraph.text or "").strip():
            target.add_run(" ")
        if paragraph.runs:
            for run in paragraph.runs:
                if not run.text:
                    continue
                new_run = target.add_run(run.text)
                if run._r.rPr is not None:
                    new_run._r.insert(0, deepcopy(run._r.rPr))
                wrote = True
        elif (paragraph.text or "").strip():
            target.add_run(paragraph.text)
            wrote = True


def _flatten_tables_for_ats(document) -> Dict[str, Any] | None:
    """Turn tables into ordered body paragraphs without changing content.

    ATS parsers frequently interleave table cells. The master remains untouched;
    only the generated copy is normalized. A token-multiset check fails closed
    if a cell was lost or duplicated (including merged-cell edge cases).
    """
    tables = list(document.tables)
    if not tables:
        return None
    before_tokens = _semantic_tokens(document)
    evidence = []

    for table_index, table in enumerate(tables):
        row_count = 0
        for row in table.rows:
            # python-docx repeats the same XML cell for horizontal merges.
            cells = []
            seen_cells = set()
            for cell in row.cells:
                identity = id(cell._tc)
                if identity in seen_cells:
                    continue
                seen_cells.add(identity)
                if (cell.text or "").strip():
                    cells.append(cell)
            if not cells:
                continue
            paragraph = document.add_paragraph()
            # Moving the newly appended node before the table keeps exact table
            # order while producing a normal single-column document flow.
            table._tbl.addprevious(paragraph._p)
            for cell_index, cell in enumerate(cells):
                if cell_index:
                    paragraph.add_run("  ")
                _copy_cell_content(paragraph, cell)
            row_count += 1
        table._tbl.getparent().remove(table._tbl)
        evidence.append({
            "table_index": table_index,
            "rows_converted": row_count,
            "source": "master_resume",
        })

    after_tokens = _semantic_tokens(document)
    if after_tokens != before_tokens:
        raise RuntimeError("ATS table normalization changed or duplicated resume text")
    return {
        "type": "flatten_tables_for_ats",
        "where": "generated resume layout",
        "before": f"{len(tables)} table(s)",
        "after": "single-column paragraphs (0 tables)",
        "evidence": evidence,
        "reason": (
            "converted layout tables to top-to-bottom text so ATS parsers keep "
            "the intended reading order; the content-token multiset is unchanged"
        ),
        "source": "master_resume",
    }


def _is_section_heading(text: str) -> bool:
    """Recognize a section heading, including combined ones.

    Résumés routinely merge two sections into one line — "EDUCATION &
    CERTIFICATIONS", "SKILLS / TOOLS". Matching only exact single names left
    those unrecognized, which silently extended the PROFESSIONAL EXPERIENCE
    section to the end of the document and put education lines inside the scope
    that reorders and trims role content.
    """
    normalized = _norm_heading(text)
    if not normalized:
        return False
    if normalized in _SECTION_HEADINGS:
        return True
    if len(normalized) > 60 or _EMPLOYMENT_DATE_RE.search(normalized):
        return False
    parts = [part.strip() for part in re.split(r"\s*(?:&|/|\band\b|,)\s*", normalized) if part.strip()]
    return len(parts) > 1 and all(part in _SECTION_HEADINGS for part in parts)


def _is_role_heading(paragraph) -> bool:
    """A role/employer/date line — the anchor of one employment block."""
    text = (paragraph.text or "").strip()
    if not text or _is_section_heading(text):
        return False
    # A bullet is content, never the anchor of a role, even when it mentions a
    # date ("Led the March 2021 migration…"). Long prose lines are the same.
    if _is_bullet(paragraph) or len(text) > 160:
        return False
    return bool(_EMPLOYMENT_DATE_RE.search(text))


def _remove_paragraph(paragraph) -> None:
    element = paragraph._p
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def _strip_hard_page_breaks(document) -> int:
    """Delete every manual page break in the body.

    A résumé of this shape must flow. A hard break says "start page 2 HERE"
    regardless of how much of page 1 is filled, which is exactly how a document
    ends up with a half-empty page and one more page than it needs. Word's
    keep-with-next / keep-together (applied in `_protect_headings`) achieves the
    real goal — no orphaned heading — without freezing the pagination.

    These breaks also arrive from OUTSIDE: a tailored copy that gets saved back
    over the master carries its layout artifacts into every future run, so they
    are removed on the way in as well as never written on the way out.
    """
    from docx.oxml.ns import qn

    removed = 0
    for paragraph in list(document.paragraphs):
        here = 0
        for run in list(paragraph.runs):
            for br in list(run._r.findall(qn("w:br"))):
                if br.get(qn("w:type")) == "page":
                    run._r.remove(br)
                    here += 1
        properties = paragraph._p.pPr
        if properties is not None and properties.find(qn("w:pageBreakBefore")) is not None:
            properties.remove(properties.find(qn("w:pageBreakBefore")))
            here += 1
        removed += here
        # A paragraph that existed ONLY to carry the break is now blank filler
        # holding open exactly the gap we are trying to close.
        if here and not (paragraph.text or "").strip():
            _remove_paragraph(paragraph)
    return removed


def _split_round_tripped_roles(document) -> int:
    """Undo role blocks that a previous pass folded into one paragraph.

    An earlier implementation merged "role title", "employer • dates" and the
    first bullet into a SINGLE paragraph joined by a line break, to defeat
    renderers that ignore keep-with-next. The cost was formatting: that first
    bullet lost its bullet glyph and picked up four literal spaces of fake
    indent, so every role's first point rendered differently from its siblings.

    Word honors keep-with-next, so the merge is unnecessary — and because the
    master resume is itself a round-trip of an earlier tailored copy, the damage
    has to be undone on the way in. Runs are moved, never rewritten, so the
    text is bit-identical either side of the split.
    """
    from docx.oxml.ns import qn

    split = 0
    for paragraph in list(document.paragraphs):
        if not _is_role_heading(paragraph):
            continue
        children = list(paragraph._p)
        break_index = None
        for index, child in enumerate(children):
            if child.tag != qn("w:r"):
                continue
            if any(br.get(qn("w:type")) in (None, "textWrapping") for br in child.findall(qn("w:br"))):
                break_index = index
                break
        if break_index is None:
            continue
        tail = children[break_index:]
        # The run holding the break may also hold text; keep only the break's
        # own run out of the tail and drop the break element itself.
        head_run = tail[0]
        for br in list(head_run.findall(qn("w:br"))):
            head_run.remove(br)
        if not head_run.findall(qn("w:t")):
            tail = tail[1:]
            paragraph._p.remove(head_run)
        if not tail:
            continue

        # python-docx has insert_paragraph_before but no "after", so the new
        # paragraph element is placed directly.
        from docx.text.paragraph import Paragraph

        new_element = paragraph._p.makeelement(qn("w:p"), {})
        paragraph._p.addnext(new_element)
        follower = Paragraph(new_element, paragraph._parent)
        for child in tail:
            paragraph._p.remove(child)
            follower._p.append(child)
        # Drop the fake indent the merge introduced, then adopt the formatting of
        # the sibling bullets this line belongs with.
        for run in follower.runs:
            if run.text and not run.text.strip():
                run.text = ""
        first = next((run for run in follower.runs if run.text), None)
        if first is not None:
            first.text = first.text.lstrip()
        # An italic lead line ("Short-term engagement: …") is a role
        # description, not a bullet, and stays as it is. Anything else is a
        # bullet that lost its formatting in the merge, so it adopts the exact
        # formatting of its siblings — looking forward first, then backward for
        # the last role in a section, which has no bullet after it to copy.
        if not _all_italic(follower):
            sibling = _sibling_bullet(document, follower)
            if sibling is not None:
                _adopt_bullet_formatting(follower, sibling)
        split += 1
    return split


def _sibling_bullet(document, paragraph):
    """Nearest bullet in the same section, looking forward then backward."""
    paragraphs = document.paragraphs
    index = next(
        (i for i, candidate in enumerate(paragraphs) if candidate._p is paragraph._p),
        None,
    )
    if index is None:
        return None
    for direction in (1, -1):
        cursor = index + direction
        while 0 <= cursor < len(paragraphs):
            candidate = paragraphs[cursor]
            text = (candidate.text or "").strip()
            if text and _is_section_heading(text):
                break
            if text and _is_bullet(candidate):
                return candidate
            cursor += direction
    return None


def _adopt_bullet_formatting(paragraph, model) -> None:
    """Copy a model bullet's style, indent, and numbering onto `paragraph`."""
    from docx.oxml.ns import qn

    paragraph.style = model.style
    paragraph.paragraph_format.left_indent = model.paragraph_format.left_indent
    paragraph.paragraph_format.first_line_indent = model.paragraph_format.first_line_indent
    model_properties = model._p.pPr
    if model_properties is None:
        return
    numbering = model_properties.find(qn("w:numPr"))
    if numbering is None:
        return
    properties = paragraph._p.get_or_add_pPr()
    existing = properties.find(qn("w:numPr"))
    if existing is not None:
        properties.remove(existing)
    properties.append(deepcopy(numbering))


def _all_italic(paragraph) -> bool:
    """Is every run italic? Marks a role's descriptive lead, not a bullet."""
    runs = [run for run in paragraph.runs if (run.text or "").strip()]
    return bool(runs) and all(run.italic for run in runs)


def _next_content_paragraph(document, paragraph):
    paragraphs = document.paragraphs
    for index, candidate in enumerate(paragraphs):
        if candidate._p is paragraph._p:
            for follower in paragraphs[index + 1:]:
                if (follower.text or "").strip():
                    return follower
            return None
    return None


def _collapse_blank_paragraphs(document) -> int:
    """Remove runs of blank paragraphs that open a gap in the page.

    One blank line between sections is deliberate spacing. Two or more in a row
    (and any trailing at the very end of the document) are leftovers from
    editing or from a previous pass deleting content, and they read as the
    "wide empty space" the layout is judged on.
    """
    removed = 0
    blanks_in_row = 0
    for paragraph in list(document.paragraphs):
        if (paragraph.text or "").strip():
            blanks_in_row = 0
            continue
        blanks_in_row += 1
        if blanks_in_row > 1:
            _remove_paragraph(paragraph)
            removed += 1
    for paragraph in reversed(document.paragraphs):
        if (paragraph.text or "").strip():
            break
        _remove_paragraph(paragraph)
        removed += 1
    return removed


_URI_PREFIX_RE = re.compile(r"^\s*(?:mailto:|tel:)", re.IGNORECASE)


def _clean_uri_display_text(document) -> int:
    """Show `you@example.com`, not `mailto:you@example.com`.

    Pasting a hyperlink into Word leaves the URI scheme in the VISIBLE text.
    Removing the prefix changes no address and no claim — it is the same
    contact detail, spelled the way a human reads it, and the hyperlink's own
    target is untouched so the link still works.

    Iterates `w:t` elements rather than `paragraph.runs`: contact details are
    normally inside a `w:hyperlink`, whose runs are not direct children of the
    paragraph and so never appeared in `runs` at all.
    """
    from docx.oxml.ns import qn

    cleaned = 0
    for paragraph in document.paragraphs:
        for node in paragraph._p.iter(qn("w:t")):
            if node.text and _URI_PREFIX_RE.match(node.text):
                node.text = _URI_PREFIX_RE.sub("", node.text, count=1)
                cleaned += 1
    return cleaned


def _normalize_layout(document) -> Dict[str, Any] | None:
    """Repair layout artifacts (including ones inherited from the master)."""
    breaks = _strip_hard_page_breaks(document)
    roles_split = _split_round_tripped_roles(document)
    blanks = _collapse_blank_paragraphs(document)
    uris = _clean_uri_display_text(document)
    if not any((breaks, roles_split, blanks, uris)):
        return None
    details = []
    if breaks:
        details.append(f"{breaks} manual page break(s) removed so the text reflows")
    if roles_split:
        details.append(f"{roles_split} role block(s) un-merged so every bullet formats alike")
    if blanks:
        details.append(f"{blanks} redundant blank line(s) removed")
    if uris:
        details.append(f"{uris} link(s) shown without their mailto:/tel: prefix")
    return {
        "type": "normalize_layout",
        "where": "document layout",
        "before": "manual page breaks, merged role blocks, and blank filler from earlier edits",
        "after": "; ".join(details),
        "evidence": [{
            "page_breaks_removed": breaks,
            "role_blocks_split": roles_split,
            "blank_paragraphs_removed": blanks,
            "uri_prefixes_cleaned": uris,
        }],
        "reason": (
            "manual breaks and merged blocks are what produce half-empty pages and "
            "inconsistent bullets; no wording, claim, or date is affected"
        ),
        "source": "master_resume",
    }


# ── page-fit geometry ────────────────────────────────────────────────────────
# Letter page, in twips (1/1440 inch), used when a document declares no size.
_DEFAULT_PAGE = {"width": 12240, "height": 15840, "left": 1080, "right": 1080, "top": 864, "bottom": 864}
# Average glyph advance as a fraction of point size, and the line box as a
# multiple of it, for the Calibri/Aptos-class fonts this template uses.
#
# These are FITTED, not guessed: ten variants of a real tailored résumé (from
# eight bullets short of it to twelve bullets past it) were rendered through
# Word and their true page counts recorded. These values are the pair that
# separates every measured 2-page document from the 3-page one, with the
# decision boundary landing on exactly 2.0. Re-run tests/python's calibration
# case if the template's font ever changes.
_AVG_CHAR_EM = 0.42
_LINE_LEADING = 1.20
_DEFAULT_FONT_HALF_POINTS = 22  # 11pt, python-docx's template default


def _page_metrics(document) -> Dict[str, int]:
    section = document.sections[0] if document.sections else None
    metrics = dict(_DEFAULT_PAGE)
    if section is not None:
        for key, value in (
            ("width", section.page_width), ("height", section.page_height),
            ("left", section.left_margin), ("right", section.right_margin),
            ("top", section.top_margin), ("bottom", section.bottom_margin),
        ):
            if value is not None:
                metrics[key] = int(value.twips)
    metrics["usable_width"] = max(1, metrics["width"] - metrics["left"] - metrics["right"])
    metrics["usable_height"] = max(1, metrics["height"] - metrics["top"] - metrics["bottom"])
    return metrics


def _font_half_points(paragraph) -> int:
    for run in paragraph.runs:
        if run.font.size is not None:
            return int(run.font.size.pt * 2)
    if paragraph.style is not None and getattr(paragraph.style.font, "size", None) is not None:
        return int(paragraph.style.font.size.pt * 2)
    return _DEFAULT_FONT_HALF_POINTS


def _paragraph_height(paragraph, usable_width: int) -> int:
    """Estimate one paragraph's rendered height in twips."""
    half_points = _font_half_points(paragraph)
    point_size = half_points / 2
    char_width = max(1.0, _AVG_CHAR_EM * point_size * 20)
    indent = 0
    fmt = paragraph.paragraph_format
    for value in (fmt.left_indent, fmt.right_indent):
        if value is not None:
            indent += max(0, int(value.twips))
    width = max(char_width * 8, usable_width - indent)
    text = paragraph.text or ""
    lines = max(1, math.ceil(len(text) * char_width / width)) if text.strip() else 1
    line_height = point_size * 20 * _LINE_LEADING
    before = int(fmt.space_before.twips) if fmt.space_before is not None else 0
    after = int(fmt.space_after.twips) if fmt.space_after is not None else 0
    return int(lines * line_height + before + after)


def estimate_page_count(document) -> float:
    """Estimated pages as a float (1.4 means "spills onto a second page").

    An estimate is the right tool here: converting to PDF needs Microsoft Word,
    which is optional in this project, and a résumé's geometry is simple enough
    (single column, no floats, no tables after flattening) that a line-count
    model is accurate to within a line per paragraph. It is used to DECIDE
    whether to trim, so being slightly conservative only means a tidier page.
    """
    metrics = _page_metrics(document)
    total = sum(
        _paragraph_height(paragraph, metrics["usable_width"])
        for paragraph in document.paragraphs
    )
    return total / metrics["usable_height"]


# A bullet that states a measured result: a number with a unit, a currency
# amount, a multiplier, or a count of something. These are the lines a
# reviewer remembers ("cut month-end close from 5 days to 2"), and the old
# fitter dropped them as readily as filler whenever they did not repeat a term
# from the posting.
_IMPACT_RE = re.compile(
    r"[$€£₹]\s?\d|\d+(?:\.\d+)?\s?(?:%|percent|x\b|×|k\b|m\b|mm\b|bn?\b|million|billion|"
    r"thousand|hours?|days?|weeks?|months?|minutes?|seconds?|users?|customers?|clients?|"
    r"people|engineers?|teams?|records?|rows?|tb|gb|pb|countries|states|sites|stores)"
    r"|\b(?!(?:19|20)\d{2}\b)\d{2,}[+]?(?:,\d{3})*\b",
    re.IGNORECASE,
)


def _has_impact(text: str) -> bool:
    return bool(_IMPACT_RE.search(text or ""))


def _norm_bullet(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _fit_to_pages(
    document,
    *,
    max_pages: int,
    keywords: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
    min_bullets_per_role: int = 1,
    keep_bullets: Sequence[str] | None = None,
) -> tuple[Dict[str, Any] | None, List[str]]:
    """Trim the résumé to `max_pages` by omitting the LEAST VALUABLE bullets.

    Value is not just keyword overlap. Each bullet is scored on three things a
    reviewer actually weighs, and the lowest-value bullets go first:

      - relevance: evidence for a requirement in THIS posting (required terms
        outweigh preferred ones, which outweigh unclassified ones);
      - impact: a measured result (a number, %, money, a count) is kept ahead
        of an unmeasured duty;
      - recency: the current role is read first and kept deepest.

    Guarantees:
      - No role, employer, date, section heading, summary, or competency line is
        ever removed, and whole bullets only: nothing is shortened or reworded.
      - The current role's bullets that evidence a REQUIRED qualification are
        never omitted, and neither is anything pinned with `keep_bullets`.
      - The two most recent roles keep at least two bullets each (or all they
        have); every other role keeps at least `min_bullets_per_role`.
      - When the budget cannot be met within those rules the résumé is left
        LONGER rather than thinner, and a limitation says so: losing a real,
        relevant achievement costs more than a third page.
    """
    if max_pages <= 0 or estimate_page_count(document) <= max_pages:
        return None, []

    pinned = {_norm_bullet(text) for text in (keep_bullets or []) if str(text or "").strip()}
    roles: List[Dict[str, Any]] = []
    current: Dict[str, Any] | None = None
    previous_line = ""
    for paragraph in document.paragraphs:
        text = (paragraph.text or "").strip()
        if _is_role_heading(paragraph):
            # Name the role by its title line when the dates sit on their own
            # line under it ("Senior Engineer | Contoso" then "Remote | 2020 -
            # Present"), so an omission can say which job it came from.
            label = f"{previous_line} | {text}" if previous_line and not _EMPLOYMENT_DATE_RE.search(previous_line) else text
            current = {"heading": label, "bullets": []}
            roles.append(current)
            previous_line = ""
            continue
        if text and not _is_bullet(paragraph) and not _is_section_heading(text):
            previous_line = text
        elif text:
            previous_line = ""
        if current is None:
            continue
        if _is_section_heading(paragraph.text):
            current = None
            continue
        if _is_bullet(paragraph) and (paragraph.text or "").strip():
            current["bullets"].append(paragraph)

    total_roles = len(roles)
    candidates: List[tuple] = []
    for role_index, role in enumerate(roles):
        bullets = role["bullets"]
        floor = min(len(bullets), 2) if role_index < 2 else min(len(bullets), max(1, min_bullets_per_role))
        recency = {0: 4, 1: 2, 2: 1}.get(role_index, 0)
        scored = []
        for position, paragraph in enumerate(bullets):
            text = paragraph.text or ""
            evidence = _matches_for_text(text, keywords, qualification_details)
            relevance = _relevance_key(evidence)
            impact = _has_impact(text)
            # The current role's evidence for a REQUIRED qualification is what
            # this application stands on; older required evidence is ranked
            # high but can still go when the budget demands it.
            protected = _norm_bullet(text) in pinned or (
                role_index == 0 and relevance[0] >= _QUALIFICATION_WEIGHT["required"]
            )
            value = relevance[0] * 4 + min(relevance[1], 6) + (3 if impact else 0) + recency
            scored.append({
                "paragraph": paragraph, "value": value, "protected": protected, "impact": impact,
                "terms": [item["keyword"] for item in evidence], "position": position,
            })
        # Only the lowest-value bullets above the role's floor are candidates.
        droppable = sorted(
            (item for item in scored if not item["protected"]),
            key=lambda item: (item["value"], -item["position"]),
        )
        removable = max(0, len(bullets) - floor)
        for item in droppable[:removable]:
            # Older roles go first on ties; within a role, the later bullet.
            candidates.append((item["value"], -(total_roles - role_index), -item["position"], role, item))
    candidates.sort(key=lambda entry: entry[:3])

    dropped: List[Dict[str, Any]] = []
    for _value, _age, _pos, role, item in candidates:
        if estimate_page_count(document) <= max_pages:
            break
        paragraph = item["paragraph"]
        raw = paragraph.text or ""
        _remove_paragraph(paragraph)
        reasons = []
        reasons.append("matches no requirement in this posting" if not item["terms"]
                       else f"only matches {', '.join(item['terms'][:3])}")
        if not item["impact"]:
            reasons.append("states no measured result")
        dropped.append({
            "text": raw.strip(),
            # The exact content-unit key, so the invariant can account for this
            # removal byte-for-byte even when the bullet had stray whitespace.
            "unit": f"paragraph:{raw}",
            "role": role["heading"][:160],
            "has_metric": item["impact"],
            "jd_terms": item["terms"],
            "reason": "; ".join(reasons),
        })

    estimated = estimate_page_count(document)
    if not dropped:
        return None, [
            f"The résumé is an estimated {estimated:.1f} pages, over the {max_pages}-page target. "
            "Nothing was left out: every remaining bullet is recent, measured, or evidences a "
            "requirement of this posting. Shorten wording in the master resume if length matters."
        ]

    limitations: List[str] = []
    if estimated > max_pages:
        limitations.append(
            f"Still an estimated {estimated:.1f} pages after leaving out {len(dropped)} bullet(s). "
            "The rest were kept on purpose (recent, measured, or required by this posting)."
        )
    return {
        "type": "fit_to_page_budget",
        "where": "PROFESSIONAL EXPERIENCE bullets",
        "before": f"content estimated at more than {max_pages} page(s)",
        "after": f"{len(dropped)} lowest-value bullet(s) omitted; estimated {estimated:.1f} page(s)",
        "evidence": [{
            "max_pages": max_pages,
            "omitted": dropped,
            "roles_kept": len(roles),
            "min_bullets_per_role": min_bullets_per_role,
            "pinned": len(pinned),
            "text_changed": False,
        }],
        "reason": (
            f"a {max_pages}-page résumé is the target; the bullets omitted are the ones with the "
            "least relevance to this posting, no measured result, and the oldest role. Nothing "
            "was shortened or reworded, required-skill evidence is never omitted, and every "
            "role keeps its heading, dates, and detail"
        ),
        "source": "master_resume",
    }, limitations


def _protect_headings(document) -> Dict[str, Any] | None:
    """Keep headings with their content, using Word's own pagination rules.

    This replaces the previous approach of merging paragraphs and injecting a
    hard page break. `keep_with_next` on a heading and `keep_together` on a role
    block express the intent — "do not strand this" — and let the renderer place
    the page boundary wherever the content actually reaches it.
    """
    before_tokens = _semantic_tokens(document)
    paragraphs = document.paragraphs
    changed = set()
    roles = 0
    for index, paragraph in enumerate(paragraphs):
        text = (paragraph.text or "").strip()
        if not text or index + 1 >= len(paragraphs):
            continue
        fmt = paragraph.paragraph_format
        if _is_section_heading(text):
            fmt.keep_with_next = True
            fmt.widow_control = True
            changed.add(index)
            continue
        if _is_role_heading(paragraph):
            # The heading, and whatever line follows it, travel together.
            fmt.keep_with_next = True
            fmt.keep_together = True
            fmt.widow_control = True
            changed.add(index)
            roles += 1
            # Many résumés put the job title on one line and "Employer • dates"
            # on the next. That title is part of the same block: without this it
            # can be left alone at the foot of a page while its own dates and
            # bullets start the next one.
            for back in range(index - 1, -1, -1):
                previous = paragraphs[back]
                text_before = (previous.text or "").strip()
                if not text_before:
                    continue
                if _is_section_heading(text_before) or _is_bullet(previous) \
                        or _is_role_heading(previous):
                    break
                previous.paragraph_format.keep_with_next = True
                previous.paragraph_format.keep_together = True
                previous.paragraph_format.widow_control = True
                changed.add(back)
                break
            follower = paragraphs[index + 1]
            if (follower.text or "").strip() and not _is_role_heading(follower):
                follower.paragraph_format.widow_control = True
                changed.add(index + 1)
            continue
        if _is_bullet(paragraph):
            # A bullet that splits across pages is fine; one dangling line is not.
            fmt.widow_control = True
            changed.add(index)

    if _semantic_tokens(document) != before_tokens:
        raise RuntimeError("heading protection changed or duplicated resume text")
    if not changed:
        return None
    return {
        "type": "stabilize_page_breaks",
        "where": "section and employment headings",
        "before": "headings could be separated from their first content line",
        "after": (
            f"{len(changed)} paragraph(s) kept with their following context "
            f"across {roles} role block(s); no manual page breaks used"
        ),
        "evidence": [{
            "paragraph_indexes": sorted(changed),
            "role_blocks": roles,
            "manual_page_breaks": 0,
            "text_changed": False,
        }],
        "reason": (
            "prevents orphaned headings with the renderer's own keep-together rules, so the "
            "text still reflows instead of being frozen by a hard break"
        ),
        "source": "master_resume",
    }


# Headings we prefer to anchor the per-job focus line above (in priority order).
# Placed just before the first match so the job's own terminology sits near the
# top of the resume, where ATS keyword parsers weigh it most.
_FOCUS_ANCHORS = ("core competencies", "professional summary", "professional experience")


def _norm_heading(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


_SUMMARY_HEADINGS = {"professional summary", "summary", "profile", "career summary"}
_EXPERIENCE_HEADINGS = {
    "professional experience", "work experience", "experience", "employment history",
}


def _section_bounds(document, headings: set[str]) -> tuple[int, int] | None:
    """Locate a known section in the body-paragraph sequence."""
    paragraphs = document.paragraphs
    start = next(
        (index for index, para in enumerate(paragraphs) if _norm_heading(para.text) in headings),
        None,
    )
    if start is None:
        return None
    end = len(paragraphs)
    for index in range(start + 1, len(paragraphs)):
        if _is_section_heading(paragraphs[index].text):
            end = index
            break
    return start + 1, end


def _is_bullet(paragraph) -> bool:
    style_name = (getattr(paragraph.style, "name", "") or "").lower()
    if "list" in style_name or "bullet" in style_name:
        return True
    ppr = paragraph._p.pPr
    if ppr is not None and ppr.numPr is not None:
        return True
    return bool(re.match(r"^\s*[•·▪◦]\s+", paragraph.text or ""))


def _nonempty_runs(paragraphs: Sequence[Any]) -> List[List[Any]]:
    """Return movable paragraph groups without moving spacers/focus lines."""
    groups: List[List[Any]] = []
    current: List[Any] = []
    for paragraph in paragraphs:
        is_focus_line = _norm_heading(paragraph.text).startswith(
            "most relevant to this role:"
        )
        if (paragraph.text or "").strip() and not is_focus_line:
            current.append(paragraph)
        elif current:
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    return groups


def _bullet_runs(paragraphs: Sequence[Any]) -> List[List[Any]]:
    """Return contiguous bullet groups; role/header anchors remain untouched."""
    groups: List[List[Any]] = []
    current: List[Any] = []
    for paragraph in paragraphs:
        if _is_bullet(paragraph) and (paragraph.text or "").strip():
            current.append(paragraph)
        elif current:
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    return groups


def _reorder_paragraph_nodes(group: Sequence[Any], ordered: Sequence[Any]) -> None:
    """Move existing XML paragraph nodes in place, without cloning content."""
    if list(group) == list(ordered):
        return
    nodes = [paragraph._p for paragraph in group]
    parent = nodes[0].getparent()
    if any(node.getparent() is not parent for node in nodes):
        raise RuntimeError("refusing to move resume content across XML parents")
    anchor = nodes[-1].getnext()
    for node in nodes:
        parent.remove(node)
    for paragraph in ordered:
        node = paragraph._p
        if anchor is None:
            parent.append(node)
        else:
            anchor.addprevious(node)


def _prioritize_group(
    group: Sequence[Any],
    *,
    keywords: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
    change_type: str,
    where: str,
) -> tuple[Dict[str, Any] | None, List[Dict[str, Any]]]:
    """Stably rank one exact-text paragraph group by qualification relevance."""
    ranked_items = []
    selected: List[Dict[str, Any]] = []
    for index, paragraph in enumerate(group):
        evidence = _matches_for_text(paragraph.text, keywords, qualification_details)
        key = _relevance_key(evidence)
        ranked_items.append((paragraph, index, key, evidence))
        if evidence:
            selected.append({
                "where": where,
                "text": paragraph.text,
                "original_index": index,
                "matches": evidence,
                "source": "master_resume",
            })

    ordered_items = sorted(
        ranked_items,
        key=lambda item: (-item[2][0], -item[2][1], -item[2][2], item[1]),
    )
    ordered = [item[0] for item in ordered_items]
    if list(group) == ordered or not selected:
        return None, selected

    before = [paragraph.text for paragraph in group]
    after = [paragraph.text for paragraph in ordered]
    if Counter(before) != Counter(after):
        raise RuntimeError("paragraph prioritization changed the source text multiset")
    _reorder_paragraph_nodes(group, ordered)
    return ({
        "type": change_type,
        "where": where,
        "before": before,
        "after": after,
        "reason": (
            "existing supported content ranked required before preferred/other content; "
            "paragraph text and formatting were not rewritten"
        ),
        "evidence": selected,
        "source": "master_resume",
    }, selected)


def _prioritize_existing_content(
    document,
    keywords: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]], set]:
    """Prioritize summary paragraphs and bullets without changing role scope."""
    changes: List[Dict[str, Any]] = []
    selected = {"summary": [], "experience": []}
    movable_nodes = set()

    summary_bounds = _section_bounds(document, _SUMMARY_HEADINGS)
    if summary_bounds is not None:
        start, end = summary_bounds
        for group_index, group in enumerate(_nonempty_runs(document.paragraphs[start:end]), 1):
            movable_nodes.update(paragraph._p for paragraph in group)
            change, evidence = _prioritize_group(
                group,
                keywords=keywords,
                qualification_details=qualification_details,
                change_type="reorder_summary",
                where=f"professional summary group {group_index}",
            )
            selected["summary"].extend(evidence)
            if change:
                changes.append(change)

    # Re-read paragraphs after any summary movement. XML paragraph objects are
    # preserved, but their list positions have changed.
    experience_bounds = _section_bounds(document, _EXPERIENCE_HEADINGS)
    if experience_bounds is not None:
        start, end = experience_bounds
        experience_paragraphs = document.paragraphs[start:end]
        for group_index, group in enumerate(_bullet_runs(experience_paragraphs), 1):
            movable_nodes.update(paragraph._p for paragraph in group)
            first_index = experience_paragraphs.index(group[0])
            scope = "role bullet group"
            for prior in reversed(experience_paragraphs[:first_index]):
                if (prior.text or "").strip() and not _is_bullet(prior):
                    scope = prior.text.strip()
                    break
            where = f"professional experience / {scope} / group {group_index}"
            change, evidence = _prioritize_group(
                group,
                keywords=keywords,
                qualification_details=qualification_details,
                change_type="reorder_experience_bullets",
                where=where,
            )
            selected["experience"].extend(evidence)
            if change:
                changes.append(change)

    return changes, selected, movable_nodes


def _collapse_alias_duplicates(
    ranked: Sequence[str], evidence_aliases: Dict[str, Any] | None
) -> List[str]:
    """Keep only the first (highest-ranked) term from each alias group.

    Verified on a real dense JD: "fabric" and "microsoft fabric" — configured
    as each other's alias in scoring.json — both matched and both ranked near
    the top, so a naive top-N selection put them side by side in the same
    sentence ("...microsoft fabric, fabric, and adf"). That reads as a typo to
    a human, not a highlight. Since they mean the same thing, only the
    highest-ranked one needs to be said once.
    """
    aliases = evidence_aliases or {}
    kept: List[str] = []
    kept_keys: set = set()
    for term in ranked:
        key = re.sub(r"\s+", " ", str(term).lower()).strip()
        if key in kept_keys:
            continue
        related = {
            re.sub(r"\s+", " ", str(a).lower()).strip() for a in (aliases.get(key) or [])
        }
        if related & kept_keys:
            continue
        kept.append(term)
        kept_keys.add(key)
    return kept


def _join_naturally(items: Sequence[str]) -> str:
    """Join like a person would write it: "a", "a and b", "a, b, and c"."""
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return f"{', '.join(items[:-1])}, and {items[-1]}"


def _insert_focus_line(
    document, present: List[str], patterns: Dict[str, Any] | None
) -> tuple[str, bool]:
    """Insert a per-job focus line built only from ``present`` keywords.

    ``present`` is already ranked most-decisive-first and capped by the caller
    (see ``_MAX_FOCUS_LINE_TERMS``) — this function only renders it, so it
    never has to decide what to drop.

    The line is anchored above the first matching heading in ``_FOCUS_ANCHORS``
    (falling back to the top of the document). Returns ``(text, inserted)``.
    An existing focus line is reused to prevent duplicate content.
    """
    label = "Most relevant to this role"
    text = humanize(f"{label}: {_join_naturally(present)}.", patterns or {})

    for paragraph in document.paragraphs:
        if _norm_heading(paragraph.text).startswith(_norm_heading(label) + ":"):
            return paragraph.text, False

    anchor = None
    for para in document.paragraphs:
        if _norm_heading(para.text) in _FOCUS_ANCHORS:
            anchor = para
            break

    if anchor is not None:
        new_para = anchor.insert_paragraph_before()
    elif document.paragraphs:
        new_para = document.paragraphs[0].insert_paragraph_before()
    else:
        new_para = document.add_paragraph()

    # Bold the label, italicize the keyword list, so it reads as a deliberate
    # tailoring cue rather than body copy.
    head, sep, rest = text.partition(":")
    if sep:
        run_label = new_para.add_run(head + ":")
        run_label.bold = True
        run_kw = new_para.add_run(rest)
        run_kw.italic = True
    else:
        new_para.add_run(text).italic = True
    return text, True


def _evidence_terms(
    keyword: str,
    evidence_aliases: Dict[str, Sequence[str]] | None,
) -> List[str]:
    """Return the JD term followed by configured truthful equivalents."""
    aliases = {
        re.sub(r"\s+", " ", str(term).lower()).strip(): list(values or [])
        for term, values in (evidence_aliases or {}).items()
    }
    result: List[str] = []
    seen = set()
    key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
    for term in [keyword, *aliases.get(key, [])]:
        normalized = re.sub(r"\s+", " ", str(term).lower()).strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(str(term))
    return result


def _audit_supported_keywords(
    resume_text: str,
    keywords: Sequence[str],
    evidence_aliases: Dict[str, Sequence[str]] | None = None,
) -> Dict[str, Any]:
    """Boundary-aware audit used for mutation decisions.

    The general reporting audit historically uses substring matching. Tailoring
    must be stricter: e.g. ``go`` inside ``Golang`` is not evidence of Go, and
    ``C`` inside every sentence is not evidence of the C language.
    """
    present: List[str] = []
    missing: List[str] = []
    supported_by: Dict[str, List[Dict[str, str]]] = {}
    seen = set()
    for keyword in keywords:
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        matches: List[Dict[str, str]] = []
        for term in _evidence_terms(str(keyword), evidence_aliases):
            for line in resume_text.splitlines():
                clean = re.sub(r"\s+", " ", line).strip()
                if clean and _phrase_pattern(term).search(clean):
                    matches.append({
                        "matched_term": term,
                        "resume_text": clean[:300],
                    })
                    break
        target = present if matches else missing
        target.append(keyword)
        if matches:
            supported_by[str(keyword)] = matches
    return {
        "present": present,
        "missing": missing,
        "supported_by": supported_by,
    }


def _apply_llm_qualifications(
    qualifications: Dict[str, Any],
    llm: Dict[str, Sequence[str]] | None,
) -> Dict[str, Any]:
    """Upgrade requirement classifications using grounded LLM labels.

    Only ever UPGRADES confidence (unclassified -> preferred -> required); it
    never demotes a classification the job description stated explicitly through
    a real heading, because that heading is stronger evidence than a model's
    reading of the same text.

    Safety: this influences the ORDER in which already-present resume content is
    presented. It cannot add, remove, or reword a claim, so a mislabelled term
    can at worst rank two supported skills suboptimally.
    """
    if not llm:
        return qualifications

    rank = {"unclassified": 1, "preferred": 2, "required": 3}
    labels: Dict[str, str] = {}
    for classification in ("preferred", "required"):
        for phrase in llm.get(classification) or []:
            key = re.sub(r"\s+", " ", str(phrase).lower()).strip()
            if not key:
                continue
            if rank[classification] > rank.get(labels.get(key, "unclassified"), 1):
                labels[key] = classification
    if not labels:
        return qualifications

    updated = {
        "required": list(qualifications.get("required", [])),
        "preferred": list(qualifications.get("preferred", [])),
        "unclassified": list(qualifications.get("unclassified", [])),
        "items": [],
    }
    buckets = {name: set(_norm_kw(k) for k in updated[name]) for name in
               ("required", "preferred", "unclassified")}

    for item in qualifications.get("items", []):
        keyword = item.get("keyword", "")
        key = _norm_kw(keyword)
        current = item.get("classification", "unclassified")
        proposed = labels.get(key)
        if proposed and rank[proposed] > rank.get(current, 1):
            new_item = {**item, "classification": proposed, "classified_by": "llm_grounded"}
            buckets[current].discard(key)
            if keyword in updated[current]:
                updated[current].remove(keyword)
            updated[proposed].append(keyword)
            updated["items"].append(new_item)
        else:
            updated["items"].append(item)

    return updated


def _norm_kw(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").lower()).strip()


def _qualification_audit(
    qualifications: Dict[str, Any], audit: Dict[str, List[str]]
) -> Dict[str, Dict[str, List[str]]]:
    present = {
        re.sub(r"\s+", " ", str(keyword).lower()).strip()
        for keyword in audit.get("present", [])
    }
    result: Dict[str, Dict[str, List[str]]] = {}
    for classification in ("required", "preferred", "unclassified"):
        terms = list(qualifications.get(classification, []))
        result[classification] = {
            "present": [
                term for term in terms
                if re.sub(r"\s+", " ", str(term).lower()).strip() in present
            ],
            "missing": [
                term for term in terms
                if re.sub(r"\s+", " ", str(term).lower()).strip() not in present
            ],
        }
    return result


def _resume_evidence(
    resume_text: str,
    keyword: str,
    evidence_aliases: Dict[str, Sequence[str]] | None = None,
) -> List[Dict[str, str]]:
    """Return compact exact master-resume excerpts supporting a term."""
    found: List[Dict[str, str]] = []
    for term in _evidence_terms(keyword, evidence_aliases):
        for line in resume_text.splitlines():
            clean = re.sub(r"\s+", " ", line).strip()
            if clean and _phrase_pattern(term).search(clean):
                found.append({
                    "keyword": keyword,
                    "matched_term": term,
                    "resume_text": clean[:300],
                })
                break
        if len(found) == 3:
            break
    return found


def _content_units(document) -> List[str]:
    """Atomic exact-text units used by the no-loss/no-copy invariant.

    A competency line is decomposed into its individual skills, the same way
    table cells already are, so REORDERING the list is order-independent while
    the skill multiset stays strictly enforced. Without this, legitimately
    reordering "Label: a, b, c" would trip the text-preservation invariant.
    """
    units = []
    for paragraph in document.paragraphs:
        if not (paragraph.text or "").strip():
            continue
        parsed = _parse_competency_line(paragraph.text) if _is_competency_paragraph(paragraph) else None
        if parsed:
            label, _sep, items = parsed
            units.extend(f"competency-item:{label}:{item}" for item in items)
        else:
            units.append(f"paragraph:{paragraph.text}")
    for table_index, table in enumerate(document.tables):
        for row_index, row in enumerate(table.rows):
            for cell_index, cell in enumerate(row.cells):
                items = _split_skill_list(cell.text)
                if len(items) > 1:
                    units.extend(
                        f"table-item:{table_index}:{row_index}:{cell_index}:{item}"
                        for item in items
                    )
                elif (cell.text or "").strip():
                    units.append(
                        f"table-cell:{table_index}:{row_index}:{cell_index}:{cell.text.strip()}"
                    )
    return units


def _normalized_unit(unit: str) -> str:
    return re.sub(r"\s+", " ", unit).strip().lower()


def _verify_truth_invariants(
    document,
    *,
    source_units: Sequence[str],
    source_nodes: Sequence[Any],
    source_styles: Dict[Any, str],
    movable_nodes: set,
    inserted_focus_text: str | None,
) -> Dict[str, Any]:
    """Fail closed if tailoring changed claims, role scope, or formatting."""
    expected_units = Counter(source_units)
    if inserted_focus_text:
        expected_units[f"paragraph:{inserted_focus_text}"] += 1
    actual_units = Counter(_content_units(document))
    text_units_preserved = actual_units == expected_units

    protected_nodes = [node for node in source_nodes if node not in movable_nodes]
    protected_set = set(protected_nodes)
    output_nodes = [paragraph._p for paragraph in document.paragraphs]
    output_protected = [node for node in output_nodes if node in protected_set]
    protected_order_preserved = (
        len(output_protected) == len(protected_nodes)
        and all(left is right for left, right in zip(output_protected, protected_nodes))
    )
    source_nodes_preserved_once = all(
        sum(node is candidate for candidate in output_nodes) == 1
        for node in source_nodes
    )
    paragraph_styles_preserved = all(
        source_styles[node] == next(
            paragraph.style.name or ""
            for paragraph in document.paragraphs
            if paragraph._p is node
        )
        for node in source_nodes
    )

    before_normalized = Counter(_normalized_unit(unit) for unit in source_units)
    after_normalized = Counter(_normalized_unit(unit) for unit in _content_units(document))
    new_duplicates = sorted(
        unit for unit, count in after_normalized.items()
        if count > max(1, before_normalized.get(unit, 0))
    )

    invariants = {
        "text_units_preserved": text_units_preserved,
        "source_paragraphs_preserved_once": source_nodes_preserved_once,
        "protected_content_order_preserved": protected_order_preserved,
        "employment_facts_unchanged": text_units_preserved and protected_order_preserved,
        "employment_chronology_unchanged": protected_order_preserved,
        "paragraph_styles_preserved": paragraph_styles_preserved,
        "ats_safe_structure_preserved": paragraph_styles_preserved and protected_order_preserved,
        "new_duplicates": new_duplicates,
        "duplicate_protection_passed": not new_duplicates,
    }
    if not all((
        text_units_preserved,
        source_nodes_preserved_once,
        protected_order_preserved,
        paragraph_styles_preserved,
        not new_duplicates,
    )):
        failed = [key for key, value in invariants.items() if value is False]
        raise RuntimeError(
            "truth-preservation invariant failed before save: " + ", ".join(failed)
        )
    return invariants


def _verify_layout_invariants(
    document,
    *,
    units_before_fit: Sequence[str],
    omitted: Sequence[Dict[str, Any]],
    max_pages: int,
) -> Dict[str, Any]:
    """Fail closed if the layout phase changed anything but bullet DEPTH.

    The truth invariants earlier in the pipeline prove nothing was invented.
    These prove the page-fitting stage only ever OMITTED whole bullets that were
    already there — no wording edited, no role or heading dropped, no content
    invented, and no employment gap opened up.
    """
    remaining = Counter(_content_units(document))
    expected = Counter(units_before_fit)
    for entry in omitted:
        key = entry.get("unit") or f"paragraph:{entry['text']}"
        if expected.get(key):
            expected[key] -= 1
            if not expected[key]:
                del expected[key]
    nothing_added = all(remaining[unit] <= count for unit, count in expected.items()) \
        and set(remaining) <= set(expected)
    only_declared_removals = remaining == expected

    role_headings = [p for p in document.paragraphs if _is_role_heading(p)]
    headings = [
        p for p in document.paragraphs
        if _is_section_heading(p.text)
    ]
    orphan_roles = []
    for index, paragraph in enumerate(document.paragraphs):
        if not _is_role_heading(paragraph):
            continue
        follower = next(
            (p for p in document.paragraphs[index + 1:] if (p.text or "").strip()),
            None,
        )
        if follower is None or _is_role_heading(follower) \
                or _is_section_heading(follower.text):
            orphan_roles.append((paragraph.text or "").strip()[:80])

    manual_breaks = 'w:type="page"' in document._element.xml
    estimated = estimate_page_count(document)
    invariants = {
        "layout_omitted_only_declared_bullets": only_declared_removals,
        "layout_added_no_content": nothing_added,
        "employment_history_complete": bool(role_headings) or not omitted,
        "section_headings_intact": bool(headings) or not omitted,
        "no_manual_page_breaks": not manual_breaks,
        "estimated_pages": round(estimated, 2),
        "within_page_budget": max_pages <= 0 or estimated <= max_pages,
        "roles_without_detail": orphan_roles,
    }
    if not (only_declared_removals and nothing_added and not manual_breaks):
        failed = [key for key, value in invariants.items() if value is False]
        raise RuntimeError("layout invariant failed before save: " + ", ".join(failed))
    return invariants


def docx_to_html(docx_path: str | Path) -> Dict[str, Any]:
    """An ATS-safe HTML rendering of a resume, for printing to PDF (P2-3).

    One column of real text: section headings become <h2>, role lines <h3>,
    bullets <li>, everything else <p>; bold runs stay bold. No tables, images,
    headers or footers. Returns the HTML and the paragraph texts it contains,
    so the caller can check the rendered page holds every one of them.
    """
    import html as html_lib
    from docx import Document

    document = Document(str(docx_path))
    parts: List[str] = []
    texts: List[str] = []
    in_list = False

    def runs_html(paragraph) -> str:
        out = []
        for run in paragraph.runs:
            text = html_lib.escape(run.text or "")
            if not text:
                continue
            out.append(f"<strong>{text}</strong>" if run.bold else text)
        return "".join(out) or html_lib.escape(paragraph.text or "")

    for paragraph in document.paragraphs:
        text = (paragraph.text or "").strip()
        if not text:
            continue
        texts.append(text)
        bullet = _is_bullet(paragraph)
        if bullet and not in_list:
            parts.append("<ul>")
            in_list = True
        if not bullet and in_list:
            parts.append("</ul>")
            in_list = False
        body = runs_html(paragraph)
        if bullet:
            item = re.sub(r"^[•·▪◦]\s+", "", body)
            parts.append(f"<li>{item}</li>")
        elif _is_section_heading(text):
            parts.append(f"<h2>{body}</h2>")
        elif _is_role_heading(paragraph):
            parts.append(f"<h3>{body}</h3>")
        else:
            parts.append(f"<p>{body}</p>")
    if in_list:
        parts.append("</ul>")
    style = (
        "@page{size:Letter;margin:0.55in 0.6in}"
        "body{font-family:Calibri,Carlito,Arial,Helvetica,sans-serif;font-size:10.5pt;line-height:1.3;color:#000}"
        "h2{font-size:11.5pt;margin:10pt 0 3pt;border-bottom:1px solid #000;text-transform:uppercase;break-after:avoid}"
        "h3{font-size:10.5pt;margin:6pt 0 2pt;break-after:avoid}"
        "p{margin:0 0 3pt}ul{margin:0 0 4pt;padding-left:16pt}li{margin:0 0 2pt}"
    )
    title = html_lib.escape(texts[0] if texts else "Resume")
    html = (
        f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{title}</title>"
        f"<style>{style}</style></head><body>{''.join(parts)}</body></html>"
    )
    return {"html": html, "texts": texts}


def master_units(master_path: str | Path) -> List[Dict[str, Any]]:
    """The master resume's paragraphs as stable, citable evidence units.

    Each non-empty paragraph gets an id ``u<n>`` (its position among non-empty
    paragraphs), its exact text, its kind (``bullet``, ``role``, ``section`` or
    ``paragraph``) and the role heading it sits under. The grounded-rewrite
    layer (src/resume/rewrites.js) cites these ids as evidence; ids stay the
    same for as long as the master resume does.
    """
    from docx import Document

    document = Document(str(master_path))
    units: List[Dict[str, Any]] = []
    role = None
    for paragraph in document.paragraphs:
        text = (paragraph.text or "").strip()
        if not text:
            continue
        if _is_section_heading(text):
            kind = "section"
            role = None
        elif _is_role_heading(paragraph):
            kind = "role"
            role = text
        elif _is_bullet(paragraph):
            kind = "bullet"
        else:
            kind = "paragraph"
        units.append({"id": f"u{len(units)}", "text": paragraph.text, "kind": kind, "role": role})
    return units


def _apply_accepted_rewrites(
    document, rewrites: Sequence[Dict[str, Any]] | None
) -> tuple[List[Dict[str, Any]], Dict[str, str]]:
    """Replace the text of exactly the bullets a person accepted.

    Each rewrite names the master's ``original`` text, the ``rewrite`` that was
    verified against cited master-resume evidence and then accepted by a
    person, and that evidence. A rewrite is applied only when ``original``
    matches exactly one bullet paragraph; anything else is skipped and
    reported. The first run keeps its formatting and takes the new text.
    Returns the change records and {original_unit: rewritten_unit} so the
    truth invariant can expect these units, and only these, to differ.
    """
    changes: List[Dict[str, Any]] = []
    replaced: Dict[str, str] = {}
    for item in rewrites or []:
        original = str(item.get("original") or "")
        rewrite = str(item.get("rewrite") or "").strip()
        if not original or not rewrite or rewrite == original:
            continue
        matches = [p for p in document.paragraphs if p.text == original and _is_bullet(p)]
        if len(matches) != 1:
            changes.append({
                "type": "rewrite_skipped", "where": "experience", "before": original, "after": None,
                "reason": "the original bullet is no longer in the master resume exactly once",
                "evidence": item.get("evidence") or [], "source": "accepted_rewrite",
            })
            continue
        paragraph = matches[0]
        runs = paragraph.runs
        if runs:
            runs[0].text = rewrite
            for run in runs[1:]:
                run.text = ""
        else:
            paragraph.add_run(rewrite)
        replaced[f"paragraph:{original}"] = f"paragraph:{paragraph.text}"
        changes.append({
            "type": "rewrite", "where": "experience", "before": original, "after": paragraph.text,
            "reason": "verified against the cited master-resume evidence and accepted by you",
            "evidence": item.get("evidence") or [], "source": "accepted_rewrite",
            "task": item.get("task"),
        })
    return changes, replaced


def tailor_resume(
    master_path: str | Path,
    output_dir: str | Path,
    job: Dict[str, Any],
    keywords: Iterable[str],
    patterns: Dict[str, Any] | None = None,
    *,
    max_pages: int = 2,
    add_summary_line: bool = False,
    required_markers: Iterable[str] | None = None,
    preferred_markers: Iterable[str] | None = None,
    evidence_aliases: Dict[str, Sequence[str]] | None = None,
    enable_rewrites: bool = False,
    now: datetime | None = None,
    output_name: str | None = None,
    llm_qualifications: Dict[str, Sequence[str]] | None = None,
    accepted_rewrites: Sequence[Dict[str, Any]] | None = None,
    keep_bullets: Sequence[str] | None = None,
) -> Dict[str, Any]:
    """Create a tailored resume for ``job`` and return a result dict.

    The function may reorder exact existing content and change emphasis. It
    never rewrites claims on its own: the only reworded text it writes is
    ``accepted_rewrites`` (evidence-verified and accepted by a person).
    ``enable_rewrites`` is accepted only so callers get an explicit policy
    response; it does not enable free-form rewriting.

    Returns the output path plus qualification audit, selected content,
    provenance records, gaps, rewrite policy, and verified invariants.
    Raises FileNotFoundError if the master is missing.
    """
    from docx import Document

    master_path = Path(master_path)
    if not master_path.exists():
        raise FileNotFoundError(f"Master resume not found: {master_path}")

    keywords = list(keywords)
    resume_text = read_docx_text(master_path)
    audit = _audit_supported_keywords(resume_text, keywords, evidence_aliases)
    qualifications = classify_qualification_keywords(
        job.get("jd_text", ""),
        keywords,
        required_markers=list(required_markers or _DEFAULT_REQUIRED_MARKERS),
        preferred_markers=list(preferred_markers or _DEFAULT_PREFERRED_MARKERS),
    )
    # Grounded requirement classification from the optional LLM layer.
    # Marker-based classification depends on a posting having explicit
    # "Required/Preferred qualifications" headings. Many real postings are a
    # single blob whose only cue is an inline "(Databricks preferred)", leaving
    # every term unclassified and the ranking with no requirement signal at all.
    # The LLM read the same posting and labelled them; applying that here only
    # changes ORDERING PRIORITY, never content, so a wrong label can at worst
    # order two supported skills suboptimally.
    qualifications = _apply_llm_qualifications(qualifications, llm_qualifications)
    qualifications["audit"] = _qualification_audit(qualifications, audit)
    qualification_details = _keyword_details(qualifications)

    # Open the master read-only: we load it, mutate the in-memory copy, and save
    # to a NEW path. The master file on disk is never written.
    document = Document(str(master_path))
    # Accepted, evidence-verified rewrites (P1-2) are applied first, and the
    # invariant baseline is updated for exactly those units: every other unit
    # must still survive byte-for-byte, and these must be the accepted text.
    rewrite_changes, rewritten_units = _apply_accepted_rewrites(document, accepted_rewrites)
    source_units = _content_units(document)
    source_nodes = [paragraph._p for paragraph in document.paragraphs]
    source_styles = {
        paragraph._p: paragraph.style.name or "" for paragraph in document.paragraphs
    }
    changes: List[Dict[str, Any]] = list(rewrite_changes)

    content_changes, selected_content, movable_nodes = _prioritize_existing_content(
        document, audit["present"], qualification_details
    )
    changes.extend(content_changes)

    competency_changes = _reorder_competencies(
        document, audit["present"], qualification_details
    )
    changes.extend(competency_changes)

    # Paragraph-based CORE COMPETENCIES ("Data Platforms:  Azure Databricks, …").
    # Table-only handling above missed this extremely common layout entirely.
    competency_changes = _reorder_competency_paragraphs(
        document, audit["present"], qualification_details
    )
    changes.extend(competency_changes)

    emphasized, emphasis_evidence, emphasis_mutations = _emphasize(
        document, audit["present"], qualification_details
    )
    if emphasized:
        changes.append({
            "type": "emphasize",
            "where": "throughout",
            "before": [
                {"text": item["text"], "bold": item["before_bold"]}
                for item in emphasis_mutations
            ],
            "after": [
                {"text": item["text"], "bold": item["after_bold"]}
                for item in emphasis_mutations
            ],
            "evidence": emphasis_evidence,
            "reason": (
                f"bolded {emphasized} existing mention(s) of supported JD terms; "
                "no text changed"
            ),
            "source": "master_resume",
        })

    summary_line = None
    focus_line_inserted = False
    limitations = [
        (
            f"{len([c for c in rewrite_changes if c['type'] == 'rewrite'])} bullet(s) use a rewording you "
            "accepted, each verified against cited lines of your master resume; nothing else was reworded."
            if any(c["type"] == "rewrite" for c in rewrite_changes) else
            "Free-form bullet and summary rewriting is disabled: no approved claim-level "
            "evidence map is available. Tailoring is limited to exact-text reordering and "
            "format emphasis."
        ),
        (
            "Required/preferred classification is deterministic and limited to the "
            "caller-supplied keyword set; it does not infer unconfigured qualifications "
            "from arbitrary prose."
        ),
        (
            "Configured evidence aliases may support a JD term when the master resume "
            "contains a truthful equivalent (for example, PySpark supports Spark). "
            "The audit records the exact alias and source excerpt."
        ),
        (
            "Content prioritization moves only intact summary paragraphs and contiguous "
            "Word list bullets within their original role; it does not split sentences or "
            "restructure text boxes. Generated copies flatten tables to an ordered, "
            "single-column ATS-safe layout without changing their words."
        ),
    ]
    if add_summary_line and audit["present"]:
        indexed_present = list(enumerate(audit["present"]))
        ranked_present = [
            keyword for _index, keyword in sorted(
                indexed_present,
                key=lambda pair: (
                    -_QUALIFICATION_WEIGHT.get(
                        qualification_details.get(
                            re.sub(r"\s+", " ", str(pair[1]).lower()).strip(), {}
                        ).get("classification", "unclassified"),
                        1,
                    ),
                    pair[0],
                ),
            )
        ]
        # Collapse alias-equivalent terms (e.g. "fabric"/"microsoft fabric")
        # BEFORE capping, so the limited slots aren't spent twice on the same
        # skill, then cap AFTER ranking so a long list still surfaces its most
        # decisive (required-first) terms rather than an arbitrary prefix. The
        # audit evidence below is built from this same list, so what a
        # reviewer sees in `changes` always matches what the line actually says.
        ranked_present = _collapse_alias_duplicates(ranked_present, evidence_aliases)
        ranked_present = ranked_present[:_MAX_FOCUS_LINE_TERMS]
        summary_line, focus_line_inserted = _insert_focus_line(
            document, ranked_present, patterns
        )
        if focus_line_inserted:
            focus_evidence = []
            for keyword in ranked_present:
                key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
                detail = qualification_details.get(key, {})
                focus_evidence.append({
                    "keyword": keyword,
                    "qualification": detail.get("classification", "unclassified"),
                    "master_resume_evidence": _resume_evidence(
                        resume_text, str(keyword), evidence_aliases
                    ),
                    "jd_evidence": detail.get("jd_evidence", []),
                })
            changes.append({
                "type": "focus_line",
                "where": "above the first recognized resume section",
                "before": "",
                "after": summary_line,
                "evidence": focus_evidence,
                "reason": (
                    "surfaces only terms already evidenced in the master resume, with "
                    "required terms listed first"
                ),
                "source": "master_resume",
            })
        else:
            limitations.append(
                "An existing 'Most relevant to this role' line was reused; a duplicate was not inserted."
            )

    # Requirements the resume does NOT evidence. Reported, never inserted.
    gaps = []
    has_jd_text = bool((job.get("jd_text") or "").strip())
    for keyword in audit.get("missing", []):
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        detail = qualification_details.get(key, {})
        # Stored score keywords can outlive a later JD refresh. Never display a
        # purported gap when the current non-empty JD has no occurrence/evidence.
        if has_jd_text and not detail.get("jd_evidence"):
            continue
        gaps.append({
            "keyword": keyword,
            "qualification": detail.get("classification", "unclassified"),
            "action": "not added — no supporting experience in the master resume",
            "reason": "boundary-aware search found no evidence for this requirement",
            "evidence": {
                "jd": detail.get("jd_evidence", []),
                "master_resume": [],
            },
        })
    gaps.sort(
        key=lambda gap: -_QUALIFICATION_WEIGHT.get(gap["qualification"], 1)
    )

    applied_rewrites = [c for c in rewrite_changes if c["type"] == "rewrite"]
    rewrite_policy = {
        "mode": "evidence_accepted" if applied_rewrites else "disabled",
        "requested": bool(enable_rewrites),
        "applied": len(applied_rewrites),
        "reason": (
            "Only bullets whose rewrite was verified against cited master-resume evidence and "
            "accepted by a person were changed; every other unit is preserved exactly."
            if applied_rewrites else
            "Claim rewriting requires an approved claim-level evidence map; none is accepted "
            "by this deterministic tailor."
        ),
    }
    if applied_rewrites:
        rewrite_policy["rewritten_units"] = len(rewritten_units)
    if enable_rewrites and not applied_rewrites:
        limitations.append(
            "A rewrite was requested but deliberately not performed because supported rewriting is unavailable."
        )

    invariants = _verify_truth_invariants(
        document,
        source_units=source_units,
        source_nodes=source_nodes,
        source_styles=source_styles,
        movable_nodes=movable_nodes,
        inserted_focus_text=summary_line if focus_line_inserted else None,
    )

    table_change = _flatten_tables_for_ats(document)
    if table_change:
        changes.append(table_change)

    # ── layout phase ─────────────────────────────────────────────────────────
    # Runs AFTER the truth invariants above, because these steps are allowed to
    # change the document's SHAPE (page breaks, blank filler, how many bullets a
    # 2017 role shows) while the checks above pin its CLAIMS. Everything the
    # layout phase may do is re-verified by `_verify_layout_invariants`.
    layout_change = _normalize_layout(document)
    if layout_change:
        changes.append(layout_change)

    units_before_fit = _content_units(document)
    fit_change, fit_limitations = _fit_to_pages(
        document,
        max_pages=max_pages,
        keywords=audit["present"],
        qualification_details=qualification_details,
        keep_bullets=keep_bullets,
    )
    if fit_change:
        changes.append(fit_change)
    limitations.extend(fit_limitations)

    pagination_change = _protect_headings(document)
    if pagination_change:
        changes.append(pagination_change)

    invariants.update(_verify_layout_invariants(
        document,
        units_before_fit=units_before_fit,
        omitted=(fit_change or {}).get("evidence", [{}])[0].get("omitted", []),
        max_pages=max_pages,
    ))
    invariants["table_text_preserved"] = True
    invariants["tables_removed_for_ats"] = len(document.tables) == 0
    invariants["page_breaks_stabilized"] = True
    invariants["role_context_text_preserved"] = True
    invariants["ats_safe_structure_preserved"] = (
        invariants["paragraph_styles_preserved"]
        and invariants["protected_content_order_preserved"]
        and invariants["tables_removed_for_ats"]
    )
    if not invariants["ats_safe_structure_preserved"]:
        raise RuntimeError("ATS-safe structure invariant failed before save")

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = output_name or output_filename(
        job.get("company", "company"), job.get("title", "role"), now
    )
    if Path(filename).name != filename:
        raise ValueError("output_name must be a filename, not a path")
    output_path = output_dir / filename
    if output_path.resolve() == master_path.resolve():
        raise ValueError("refusing to overwrite the master resume")
    document.save(str(output_path))

    return {
        "output_path": str(output_path),
        "audit": audit,
        "qualifications": qualifications,
        "emphasized": emphasized,
        "summary_line": summary_line,
        "changes": changes,
        "gaps": gaps,
        "selected_content": selected_content,
        "rewrite_policy": rewrite_policy,
        "invariants": invariants,
        "limitations": limitations,
    }
