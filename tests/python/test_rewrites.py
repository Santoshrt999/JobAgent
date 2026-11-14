"""Grounded rewrites (P1-2): master units are citable, and only accepted
rewrites of existing bullets change the output; every other unit is preserved."""
from docx import Document

from tailor import master_units, read_docx_text, tailor_resume


def _resume(tmp_path):
    doc = Document()
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Data Engineer, Acme Corp | Jan 2021 - Present")
    doc.add_paragraph("Built medallion pipelines on Azure Databricks with PySpark.", style="List Bullet")
    doc.add_paragraph("Developed Power BI semantic models for finance analytics.", style="List Bullet")
    doc.add_paragraph("EDUCATION")
    doc.add_paragraph("B.S. Computer Science, State University")
    path = tmp_path / "MASTER_RESUME.docx"
    doc.save(str(path))
    return path


def test_master_units_have_ids_kinds_and_roles(tmp_path):
    units = master_units(_resume(tmp_path))
    kinds = [(u["id"], u["kind"]) for u in units]
    assert kinds[:4] == [("u0", "section"), ("u1", "role"), ("u2", "bullet"), ("u3", "bullet")]
    assert units[2]["role"] == "Data Engineer, Acme Corp | Jan 2021 - Present"
    assert units[5]["role"] is None


def test_accepted_rewrite_changes_exactly_that_bullet(tmp_path):
    master = _resume(tmp_path)
    original = "Built medallion pipelines on Azure Databricks with PySpark."
    rewrite = "Built Azure Databricks medallion pipelines with PySpark."
    result = tailor_resume(
        master, tmp_path / "out", {"company": "Globex", "title": "Data Engineer", "jd_text": "Databricks"},
        ["databricks"], accepted_rewrites=[{"original": original, "rewrite": rewrite, "evidence": ["u2"]}],
    )
    text = read_docx_text(result["output_path"])
    assert rewrite in text and original not in text
    assert "Developed Power BI semantic models for finance analytics." in text
    assert result["invariants"]["text_units_preserved"] is True
    assert result["rewrite_policy"]["mode"] == "evidence_accepted"
    assert result["rewrite_policy"]["applied"] == 1
    assert any(c["type"] == "rewrite" and c["before"] == original for c in result["changes"])
    # The master itself is untouched.
    assert original in read_docx_text(master)


def test_rewrite_of_a_bullet_that_no_longer_exists_is_skipped(tmp_path):
    result = tailor_resume(
        _resume(tmp_path), tmp_path / "out", {"company": "Globex", "title": "DE", "jd_text": ""}, [],
        accepted_rewrites=[{"original": "A bullet that was edited away.", "rewrite": "Anything."}],
    )
    assert result["rewrite_policy"]["applied"] == 0
    assert any(c["type"] == "rewrite_skipped" for c in result["changes"])
    assert "Anything." not in read_docx_text(result["output_path"])
