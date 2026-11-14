"""Tests for the resume format + content validator."""
from docx import Document

from validate import validate_resume


def _make_resume(tmp_path, paragraphs, name="resume.docx"):
    doc = Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    path = tmp_path / name
    doc.save(str(path))
    return path


def _good_paragraphs():
    # ~160 words across the core sections with contact details.
    filler = "Built and shipped reliable data pipelines and analytics across teams. " * 12
    return [
        "Priya Raghunathan",
        "priya@example.com | 555-123-4567",
        "Experience",
        "Senior Data Engineer — " + filler,
        "Education",
        "B.Tech in Computer Science, 2018.",
        "Skills",
        "Python, PySpark, Azure Databricks, Delta Lake, Power BI, SQL.",
    ]


def test_valid_resume_passes(tmp_path):
    path = _make_resume(tmp_path, _good_paragraphs())
    result = validate_resume(path, keywords=["python", "pyspark", "azure"])
    assert result["ok"] is True
    assert result["issues"] == []
    assert result["sections"] == {"experience": True, "education": True, "skills": True}
    assert result["has_email"] is True
    assert result["has_phone"] is True
    assert result["keyword_coverage"]["ratio"] == 1.0


def test_missing_file_is_a_hard_issue(tmp_path):
    result = validate_resume(tmp_path / "nope.docx")
    assert result["ok"] is False
    assert any("not found" in i for i in result["issues"])


def test_empty_resume_is_a_hard_issue(tmp_path):
    path = _make_resume(tmp_path, [""])
    result = validate_resume(path)
    assert result["ok"] is False
    assert any("empty" in i for i in result["issues"])


def test_missing_all_sections_and_contact_is_hard_issue(tmp_path):
    # Enough words, but no sections and no contact details.
    body = "word " * 200
    path = _make_resume(tmp_path, [body])
    result = validate_resume(path)
    assert result["ok"] is False
    assert any("core sections" in i for i in result["issues"])
    assert any("contact details" in i for i in result["issues"])


def test_one_missing_section_is_a_warning_not_an_issue(tmp_path):
    paragraphs = _good_paragraphs()
    # Drop the Education section header + line.
    paragraphs = [p for p in paragraphs if not p.startswith("Education") and "B.Tech" not in p]
    result = validate_resume(_make_resume(tmp_path, paragraphs))
    assert result["ok"] is True  # still no hard issues
    assert any("missing section" in w for w in result["warnings"])


def test_low_keyword_coverage_is_a_warning(tmp_path):
    path = _make_resume(tmp_path, _good_paragraphs())
    result = validate_resume(path, keywords=["kafka", "snowflake", "terraform", "python"])
    assert result["ok"] is True
    assert result["keyword_coverage"]["ratio"] < 0.4
    assert any("keyword coverage" in w for w in result["warnings"])


# Measured 2026-11-13: a resume whose email and phone sit only in the Word page
# header was refused with "resume has no contact details", because the check read
# the body alone. Headers, footers and text boxes are where a resume puts them.
def _body_without_contact():
    return [p for p in _good_paragraphs() if "@" not in p]


def _text_box_xml(text):
    return (
        '<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:pict><w:txbxContent><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:txbxContent></w:pict></w:r>'
    )


def _save_with(tmp_path, place):
    doc = Document()
    for p in _body_without_contact():
        doc.add_paragraph(p)
    place(doc)
    path = tmp_path / "resume.docx"
    doc.save(str(path))
    return path


def test_contact_in_page_header_counts(tmp_path):
    path = _save_with(tmp_path, lambda d: d.sections[0].header.paragraphs[0].add_run("priya@example.com | 555-123-4567"))
    result = validate_resume(path)
    assert result["has_email"] is True
    assert result["has_phone"] is True
    assert not any("contact" in i for i in result["issues"])
    assert result["ok"] is True


def test_contact_in_page_footer_counts(tmp_path):
    path = _save_with(tmp_path, lambda d: d.sections[0].footer.paragraphs[0].add_run("priya@example.com"))
    result = validate_resume(path)
    assert result["has_email"] is True
    assert result["ok"] is True


def test_contact_in_a_text_box_counts(tmp_path):
    from lxml import etree

    def place(doc):
        doc.sections[0].header.paragraphs[0]._p.append(etree.fromstring(_text_box_xml("priya@example.com")))

    result = validate_resume(_save_with(tmp_path, place))
    assert result["has_email"] is True
    assert result["ok"] is True


def test_contact_in_a_later_sections_header_counts(tmp_path):
    from docx.enum.section import WD_SECTION

    def place(doc):
        doc.add_section(WD_SECTION.NEW_PAGE)
        second = doc.sections[1]
        second.header.is_linked_to_previous = False
        second.header.paragraphs[0].add_run("555-123-4567")

    result = validate_resume(_save_with(tmp_path, place))
    assert result["has_phone"] is True
    assert result["ok"] is True


def test_no_contact_anywhere_is_still_a_hard_issue(tmp_path):
    # The guard stays: header and footer exist but hold no email or phone.
    def place(doc):
        doc.sections[0].header.paragraphs[0].add_run("Priya Raghunathan")
        doc.sections[0].footer.paragraphs[0].add_run("Page 1")

    result = validate_resume(_save_with(tmp_path, place))
    assert result["ok"] is False
    assert any("no contact details" in i for i in result["issues"])


def test_header_text_does_not_change_the_word_count_or_sections(tmp_path):
    plain = validate_resume(_save_with(tmp_path, lambda d: None))
    headed = validate_resume(_save_with(tmp_path, lambda d: d.sections[0].header.paragraphs[0].add_run("priya@example.com")))
    assert headed["word_count"] == plain["word_count"]
    assert headed["sections"] == plain["sections"]
