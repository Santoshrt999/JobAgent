"""Tailoring keeps what matters when it has to shorten a résumé.

The page fit used to treat every bullet as equal apart from keyword overlap,
and recognised a role only by a full month name. These tests pin the rules
that replaced that: roles are found in every common date style, measured
results outlive unmeasured duties, pinned bullets are never omitted, and each
omission says which role it came from and why.
"""
from docx import Document

from tailor import _EMPLOYMENT_DATE_RE, _has_impact, tailor_resume


def _long_resume(path, date_style):
    doc = Document()
    doc.add_paragraph("CANDIDATE NAME")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    roles = [
        ("Senior Engineer | Acme", date_style[0], "Shipped SQL service release"),
        ("Engineer | Beta Co", date_style[1], "Maintained internal wiki page"),
        ("Analyst | Gamma Inc", date_style[2], "Prepared weekly status slides"),
    ]
    for title, dates, filler in roles:
        doc.add_paragraph(title)
        doc.add_paragraph(f"Remote | {dates}")
        doc.add_paragraph(f"Cut report runtime from 6 hours to 40 minutes for {title}.", style="List Bullet")
        for index in range(9):
            doc.add_paragraph(f"{filler} item {index}. " * 9, style="List Bullet")
    doc.add_paragraph("EDUCATION")
    doc.add_paragraph("B.S. Computer Science, 2014")
    doc.save(path)
    return path


def test_role_dates_are_recognised_in_every_common_style():
    for text in ("Jan 2020 - Present", "Mar 2017 – Dec 2019", "Sept 2015 to Feb 2017",
                 "03/2018 - 11/2019", "2015 – 2018", "2019 - Current", "April 2022 - Present"):
        assert _EMPLOYMENT_DATE_RE.search(text), text
    # A single year is an education or certification date, not a role.
    assert not _EMPLOYMENT_DATE_RE.search("B.S. Computer Science, 2014")


def test_measured_results_are_detected():
    assert _has_impact("Cut month-end close from 5 days to 2")
    assert _has_impact("Saved $1.2M in licence costs")
    assert _has_impact("Improved query speed by 40%")
    assert _has_impact("Supported 200+ analysts")
    assert not _has_impact("Maintained documentation for the team")
    assert not _has_impact("Joined the company in 2019")


def test_abbreviated_dates_keep_every_role_and_its_measured_result(tmp_path, humanizer_patterns):
    master = _long_resume(tmp_path / "ABBR.docx", ("Jan 2022 - Present", "Mar 2019 - Dec 2021", "2016 - 2019"))
    result = tailor_resume(
        master, tmp_path / "out",
        {"company": "Example", "title": "Engineer", "jd_text": "Nice to have: Kafka."},
        keywords=["kafka"], patterns=humanizer_patterns, max_pages=1,
    )
    texts = [p.text for p in Document(result["output_path"]).paragraphs]
    joined = "\n".join(texts)
    # Three roles were seen, so each keeps detail of its own; the old reader saw
    # one role and could leave Beta Co and Gamma Inc with no bullets at all.
    fit = next(c for c in result["changes"] if c["type"] == "fit_to_page_budget")
    assert fit["evidence"][0]["roles_kept"] == 3
    for title in ("Acme", "Beta Co", "Gamma Inc"):
        assert "Cut report runtime from 6 hours to 40 minutes for" in joined
        assert any(title in t and "40 minutes" in t for t in texts), f"{title} lost its measured result"
    assert result["invariants"]["roles_without_detail"] == []
    # Every omission says where it came from and why.
    for entry in fit["evidence"][0]["omitted"]:
        assert entry["role"]
        assert entry["has_metric"] is False
        assert "measured result" in entry["reason"]


def test_pinned_bullets_are_never_omitted(tmp_path, humanizer_patterns):
    master = _long_resume(tmp_path / "PIN.docx", ("January 2022 - Present", "March 2019 - December 2021", "June 2016 - February 2019"))
    first = tailor_resume(
        master, tmp_path / "a",
        {"company": "Example", "title": "Engineer", "jd_text": ""},
        keywords=[], patterns=humanizer_patterns, max_pages=1,
    )
    omitted = next(c for c in first["changes"] if c["type"] == "fit_to_page_budget")["evidence"][0]["omitted"]
    pin = omitted[0]["text"]
    second = tailor_resume(
        master, tmp_path / "b",
        {"company": "Example", "title": "Engineer", "jd_text": ""},
        keywords=[], patterns=humanizer_patterns, max_pages=1, keep_bullets=[pin],
    )
    assert pin in [p.text.strip() for p in Document(second["output_path"]).paragraphs]


def test_zero_page_budget_means_never_trim(tmp_path, humanizer_patterns):
    master = _long_resume(tmp_path / "ZERO.docx", ("Jan 2022 - Present", "Mar 2019 - Dec 2021", "2016 - 2019"))
    result = tailor_resume(
        master, tmp_path / "out",
        {"company": "Example", "title": "Engineer", "jd_text": ""},
        keywords=[], patterns=humanizer_patterns, max_pages=0,
    )
    assert not any(c["type"] == "fit_to_page_budget" for c in result["changes"])
    assert len(Document(result["output_path"]).paragraphs) == len(Document(str(master)).paragraphs)
