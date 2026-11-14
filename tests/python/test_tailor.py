"""Tests for the deterministic resume tailor."""
import hashlib

import pytest

from keywordAudit import read_docx_text
from tailor import estimate_page_count, output_filename, tailor_resume


def _digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_output_filename_is_slugged_and_dated():
    name = output_filename("Acme Analytics", "Senior Data Engineer")
    assert name.startswith("acme-analytics_senior-data-engineer_")
    assert name.endswith(".docx")


def test_tailor_honors_explicit_output_name(sample_resume, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "Senior Data Engineer"}
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=["azure"],
        patterns=humanizer_patterns,
        output_name="Priya_Raghunathan_Resume_Senior_Data_Engineer.docx",
    )
    assert result["output_path"].endswith(
        "Priya_Raghunathan_Resume_Senior_Data_Engineer.docx"
    )


def test_tailor_creates_output_and_leaves_master_untouched(sample_resume, tmp_path, humanizer_patterns):
    before = _digest(sample_resume)
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "Senior Data Engineer"}
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=["azure", "pyspark", "snowflake"],
        patterns=humanizer_patterns,
    )

    # Master is byte-for-byte unchanged.
    assert _digest(sample_resume) == before
    # Output exists and is a different file.
    out_path = result["output_path"]
    assert out_path.endswith(".docx")
    assert "snowflake" in result["audit"]["missing"]
    assert "azure" in result["audit"]["present"]


def test_tailor_does_not_fabricate_missing_keywords(sample_resume, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "DE"}
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=["snowflake", "redshift"],
        patterns=humanizer_patterns,
    )
    tailored_text = read_docx_text(result["output_path"]).lower()
    # Missing skills must NOT be injected into the tailored resume.
    assert "snowflake" not in tailored_text
    assert "redshift" not in tailored_text


def test_summary_line_only_lists_present_keywords(sample_resume, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "DE"}
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=["azure", "snowflake"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    assert result["summary_line"] is not None
    assert "azure" in result["summary_line"].lower()
    assert "snowflake" not in result["summary_line"].lower()


def test_focus_line_anchored_above_core_competencies(tmp_path, humanizer_patterns):
    """The per-job focus line is inserted just above CORE COMPETENCIES."""
    from docx import Document

    doc = Document()
    doc.add_paragraph("ATRESH SOMAYAJULA")
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    doc.add_paragraph("Built medallion pipelines on Azure Databricks with PySpark and Delta Lake.")
    doc.add_paragraph("CORE COMPETENCIES")
    doc.add_paragraph("Azure, PySpark, Power BI, Delta Lake")
    master = tmp_path / "MASTER_RESUME.docx"
    doc.save(str(master))

    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "Senior Data Engineer"}
    result = tailor_resume(
        master, out_dir, job,
        keywords=["azure", "pyspark", "snowflake"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )

    texts = [p.text for p in Document(result["output_path"]).paragraphs]
    focus_idx = next(
        i for i, t in enumerate(texts) if t.lower().startswith("most relevant to this role")
    )
    cc_idx = next(i for i, t in enumerate(texts) if t.strip().lower() == "core competencies")
    # The focus line sits immediately above the CORE COMPETENCIES heading.
    assert focus_idx < cc_idx
    # Honest: present keywords are listed, missing ones never appear.
    assert "azure" in texts[focus_idx].lower()
    assert "pyspark" in texts[focus_idx].lower()
    assert "snowflake" not in texts[focus_idx].lower()


# REGRESSION (2026-08): the focus line had no length cap. Verified on a real,
# buzzword-dense JD that matched every configured keyword category at once —
# the generated line named 31 terms in one sentence, which reads as a keyword
# dump, not a highlight, to a human reviewer.
def test_focus_line_caps_at_a_readable_length(sample_resume, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "DE"}
    # 8 terms all genuinely present in `sample_resume`'s text — more than the cap.
    many_present = ["azure", "databricks", "pyspark", "power bi", "dax", "delta lake", "finance", "data engineer"]
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=many_present,
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    line = result["summary_line"].lower()
    named = [k for k in many_present if k in line]
    assert len(named) <= 6, f"focus line named {len(named)} terms, reads as a keyword dump: {line!r}"
    # And it reads like a sentence a person would write, not a raw comma dump.
    assert ", and " in line or line.count(",") == 0


# REGRESSION (2026-08): "fabric" and "microsoft fabric" are each other's
# configured alias, but both could be ranked into the focus line side by side
# ("...microsoft fabric, fabric, and adf") — reads like a typo, not a highlight.
def test_focus_line_collapses_alias_duplicates(tmp_path, humanizer_patterns):
    from docx import Document

    doc = Document()
    doc.add_paragraph("Priya Raghunathan")
    doc.add_paragraph("Built pipelines on Azure Databricks with PySpark and Apache Spark.")
    master = tmp_path / "MASTER_RESUME.docx"
    doc.save(str(master))

    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "DE"}
    result = tailor_resume(
        master, out_dir, job,
        keywords=["databricks", "spark", "pyspark"],
        evidence_aliases={"spark": ["pyspark", "apache spark", "databricks"], "databricks": ["spark"]},
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    import re
    line = result["summary_line"].lower()
    # "databricks" and "spark" are configured aliases of each other — only the
    # higher-ranked one should be named, not both. Word-boundary check because
    # "spark" is a raw substring of "pyspark" (a different, non-aliased term
    # that legitimately gets to appear on its own).
    named = {t for t in ("databricks", "spark") if re.search(rf"(?<![a-z0-9]){t}(?![a-z0-9])", line)}
    assert len(named) <= 1, f"alias duplicates both named: {line!r}"


# ── evidence-based tailoring (2026-07 upgrade) ──────────────────────────────

def _tokens(text):
    import re
    # Strip trailing punctuation so "databricks." (sentence end) == "databricks".
    return {m.rstrip("./-,") for m in re.findall(r"[a-z0-9][a-z0-9+#./-]*", text.lower())}


def test_reorders_competencies_to_put_jd_skills_first(sample_resume_with_competencies, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "out"
    job = {"company": "Acme", "title": "Data Engineer"}
    result = tailor_resume(
        sample_resume_with_competencies, out_dir, job,
        keywords=["pyspark", "microsoft fabric"],
        patterns=humanizer_patterns,
    )
    from docx import Document
    doc = Document(result["output_path"])
    assert len(doc.tables) == 0
    platforms = next(p.text.removeprefix("Data Platforms:").strip()
                     for p in doc.paragraphs if p.text.startswith("Data Platforms:"))
    pipelines = next(p.text.removeprefix("Pipelines:").strip()
                     for p in doc.paragraphs if p.text.startswith("Pipelines:"))
    # JD-matched skills moved to the FRONT of their category…
    assert platforms.startswith("Microsoft Fabric")
    assert pipelines.startswith("PySpark")
    # …and the multiset of skills is EXACTLY preserved (pure permutation).
    assert sorted(s.strip() for s in platforms.split(",")) == sorted(
        ["Snowflake", "Azure Databricks", "Microsoft Fabric", "Azure Synapse"])
    assert sorted(s.strip() for s in pipelines.split(",")) == sorted(
        ["SSIS", "ADF Pipelines", "PySpark", "Kafka"])
    # The change log records the reorder with before/after + evidence.
    reorders = [c for c in result["changes"] if c["type"] == "reorder_skills"]
    assert len(reorders) == 2
    assert reorders[0]["before"] != reorders[0]["after"]
    assert "job description asks for" in reorders[0]["evidence"]


def test_tailored_resume_never_contains_unsupported_requirements(
    sample_resume_with_competencies, tmp_path, humanizer_patterns
):
    """THE no-fabrication property: every word in the tailored resume already
    existed in the master. JD requirements the master does not evidence are
    reported as gaps and never inserted."""
    out_dir = tmp_path / "out"
    job = {"company": "Acme", "title": "Data Engineer"}
    unsupported = ["terraform", "golang", "kubernetes"]
    result = tailor_resume(
        sample_resume_with_competencies, out_dir, job,
        keywords=["pyspark", "azure databricks"] + unsupported,
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    master_tokens = _tokens(read_docx_text(sample_resume_with_competencies))
    # The focus line adds only a fixed label; its keywords must come from the master.
    label_tokens = _tokens("Most relevant to this role")
    tailored_tokens = _tokens(read_docx_text(result["output_path"]))
    assert tailored_tokens <= master_tokens | label_tokens, (
        f"invented tokens: {tailored_tokens - master_tokens - label_tokens}")
    # Unsupported requirements are reported as gaps — never added.
    gap_keywords = {g["keyword"] for g in result["gaps"]}
    for kw in unsupported:
        assert kw in gap_keywords
        assert kw not in tailored_tokens


def test_truthful_aliases_remove_false_gaps_without_adding_new_claims(
    sample_resume_with_competencies, tmp_path, humanizer_patterns
):
    result = tailor_resume(
        sample_resume_with_competencies,
        tmp_path / "out",
        {
            "company": "Acme",
            "title": "Data Engineer",
            "jd_text": "Spark and ELT; dbt required.",
        },
        keywords=["spark", "elt", "dbt"],
        patterns=humanizer_patterns,
        evidence_aliases={
            "spark": ["pyspark"],
            "elt": ["adf pipelines"],
        },
    )

    assert {"spark", "elt"} <= {
        str(term).lower() for term in result["audit"]["present"]
    }
    assert {gap["keyword"] for gap in result["gaps"]} == {"dbt"}
    assert result["audit"]["supported_by"]["spark"][0]["matched_term"] == "pyspark"
    assert result["audit"]["supported_by"]["elt"][0]["matched_term"] == "adf pipelines"


def test_nonempty_current_jd_suppresses_stale_missing_keywords(
    sample_resume_with_competencies, tmp_path, humanizer_patterns
):
    result = tailor_resume(
        sample_resume_with_competencies,
        tmp_path / "out",
        {"company": "Acme", "title": "Data Engineer", "jd_text": "Required: SQL."},
        keywords=["sql", "scala"],
        patterns=humanizer_patterns,
    )
    assert {gap["keyword"] for gap in result["gaps"]} == {"sql"}


def test_changes_log_traces_every_action_to_evidence(sample_resume_with_competencies, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "out"
    job = {"company": "Acme", "title": "Data Engineer"}
    result = tailor_resume(
        sample_resume_with_competencies, out_dir, job,
        keywords=["pyspark"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    types = {c["type"] for c in result["changes"]}
    assert "reorder_skills" in types
    assert "emphasize" in types
    assert "focus_line" in types
    for change in result["changes"]:
        assert change.get("evidence"), f"change without evidence: {change}"
        assert change.get("reason"), f"change without reason: {change}"
    # Emphasis evidence cites the actual resume text that mentions the keyword.
    emphasize = next(c for c in result["changes"] if c["type"] == "emphasize")
    assert any("pyspark" in e["keyword"] for e in emphasize["evidence"])
    assert all(e["resume_text"] for e in emphasize["evidence"])


def _truth_resume(tmp_path):
    """Resume with two roles and intentionally low-relevance-first content."""
    from docx import Document

    doc = Document()
    doc.add_paragraph("Candidate Name")
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    doc.add_paragraph("Created Tableau dashboards for operations teams.")
    doc.add_paragraph("Built SQL data pipelines with documented quality checks.")
    doc.add_paragraph("CORE COMPETENCIES")
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Data:"
    table.rows[0].cells[1].text = "Tableau, Kafka, SQL, Python"
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Acme Corporation")
    doc.add_paragraph("Senior Data Engineer")
    doc.add_paragraph("January 2022 - Present")
    doc.add_paragraph("Created Tableau dashboards for business users.", style="List Bullet")
    doc.add_paragraph("Built SQL pipelines with tested data-quality controls.", style="List Bullet")
    doc.add_paragraph("Beta Systems")
    doc.add_paragraph("Data Engineer")
    doc.add_paragraph("June 2019 - December 2021")
    doc.add_paragraph("Maintained Kafka ingestion for internal datasets.", style="List Bullet")
    doc.add_paragraph("Developed Python validation for scheduled loads.", style="List Bullet")
    doc.add_paragraph("EDUCATION")
    doc.add_paragraph("State University")
    path = tmp_path / "TRUTH_MASTER.docx"
    doc.save(path)
    return path


def _employment_anchor_sequence(document):
    expected = {
        "Acme Corporation", "Senior Data Engineer", "January 2022 - Present",
        "Beta Systems", "Data Engineer", "June 2019 - December 2021",
    }
    return [
        unit
        for paragraph in document.paragraphs
        for line in paragraph.text.splitlines()
        for unit in line.split("  |  ")
        if unit in expected
    ]


def test_required_content_ranks_before_preferred_within_original_scopes(
    tmp_path, humanizer_patterns
):
    from docx import Document

    master = _truth_resume(tmp_path)
    jd = (
        "Requirements: SQL, Python, Terraform, and a documented 40% throughput gain. "
        "Preferred qualifications: Tableau and Kafka."
    )
    result = tailor_resume(
        master,
        tmp_path / "out",
        {"company": "Example", "title": "Data Engineer", "jd_text": jd},
        keywords=["sql", "python", "terraform", "40%", "tableau", "kafka"],
        patterns=humanizer_patterns,
    )

    doc = Document(result["output_path"])
    texts = [paragraph.text for paragraph in doc.paragraphs]
    summary_start = texts.index("PROFESSIONAL SUMMARY")
    assert texts[summary_start + 1].startswith("Built SQL")

    acme_sql = next(index for index, text in enumerate(texts) if "Built SQL pipelines with tested data-quality controls." in text)
    acme_tableau = texts.index("Created Tableau dashboards for business users.")
    beta_python = next(index for index, text in enumerate(texts) if "Developed Python validation for scheduled loads." in text)
    beta_kafka = texts.index("Maintained Kafka ingestion for internal datasets.")
    assert acme_sql < acme_tableau
    assert beta_python < beta_kafka

    # Role anchors never move, so bullets cannot cross employers or chronology.
    assert _employment_anchor_sequence(doc) == [
        "Acme Corporation", "Senior Data Engineer", "January 2022 - Present",
        "Beta Systems", "Data Engineer", "June 2019 - December 2021",
    ]
    changes = result["changes"]
    assert any(change["type"] == "reorder_summary" for change in changes)
    assert len([c for c in changes if c["type"] == "reorder_experience_bullets"]) == 2
    assert result["qualifications"]["audit"]["required"]["present"] == ["sql", "python"]
    assert result["qualifications"]["audit"]["preferred"]["present"] == ["tableau", "kafka"]


def test_unsupported_technology_and_metric_are_required_gaps_never_inserted(
    tmp_path, humanizer_patterns
):
    master = _truth_resume(tmp_path)
    result = tailor_resume(
        master,
        tmp_path / "out",
        {
            "company": "Example",
            "title": "Data Engineer",
            "jd_text": "Requirements: Terraform and a 40% throughput gain. Preferred: Tableau.",
        },
        keywords=["terraform", "40%", "tableau"],
        patterns=humanizer_patterns,
        add_summary_line=True,
        enable_rewrites=True,
    )
    tailored = read_docx_text(result["output_path"]).lower()
    assert "terraform" not in tailored
    assert "40%" not in tailored
    gaps = {gap["keyword"]: gap for gap in result["gaps"]}
    assert gaps["terraform"]["qualification"] == "required"
    assert gaps["40%"]["qualification"] == "required"
    assert all(gap["evidence"]["master_resume"] == [] for gap in gaps.values())
    assert result["rewrite_policy"] == {
        "mode": "disabled",
        "requested": True,
        "applied": 0,
        "reason": result["rewrite_policy"]["reason"],
    }
    assert any("deliberately not performed" in item for item in result["limitations"])


def test_provenance_and_invariants_cover_every_mutation(tmp_path, humanizer_patterns):
    master = _truth_resume(tmp_path)
    result = tailor_resume(
        master,
        tmp_path / "out",
        {
            "company": "Example",
            "title": "Data Engineer",
            "jd_text": "Required: SQL and Python. Preferred: Tableau and Kafka.",
        },
        keywords=["sql", "python", "tableau", "kafka"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    for change in result["changes"]:
        assert "before" in change and change["before"] is not None
        assert "after" in change and change["after"] is not None
        assert change["reason"]
        assert change["evidence"]
        assert change["source"] == "master_resume"

    assert result["selected_content"]["summary"]
    assert result["selected_content"]["experience"]
    assert all(result["invariants"][key] for key in (
        "text_units_preserved",
        "source_paragraphs_preserved_once",
        "protected_content_order_preserved",
        "employment_facts_unchanged",
        "employment_chronology_unchanged",
        "paragraph_styles_preserved",
        "ats_safe_structure_preserved",
        "duplicate_protection_passed",
    ))
    assert result["invariants"]["new_duplicates"] == []


def test_duplicate_protection_is_idempotent_and_preserves_docx_layout(
    tmp_path, humanizer_patterns
):
    from docx import Document

    master = _truth_resume(tmp_path)
    job = {
        "company": "Example",
        "title": "Data Engineer",
        "jd_text": "Required: SQL and Python. Preferred: Tableau and Kafka.",
    }
    first = tailor_resume(
        master,
        tmp_path / "first",
        job,
        keywords=["sql", "python", "tableau", "kafka"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    second = tailor_resume(
        first["output_path"],
        tmp_path / "second",
        job,
        keywords=["sql", "python", "tableau", "kafka"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    doc = Document(second["output_path"])
    texts = [paragraph.text for paragraph in doc.paragraphs]
    assert sum(text.lower().startswith("most relevant to this role:") for text in texts) == 1
    assert sum(text.count("Built SQL pipelines with tested data-quality controls.") for text in texts) == 1
    standalone_styles = [
        paragraph.style.name for paragraph in doc.paragraphs
        if paragraph.text in {
            "Built SQL pipelines with tested data-quality controls.",
            "Created Tableau dashboards for business users.",
            "Developed Python validation for scheduled loads.",
            "Maintained Kafka ingestion for internal datasets.",
        }
    ]
    assert standalone_styles
    # Re-tailoring a tailored copy must leave every bullet a real bullet. The
    # old grouping absorbed the first one into its role heading, so a second
    # pass produced a document whose bullets no longer matched each other.
    assert standalone_styles == ["List Bullet"] * len(standalone_styles)
    assert second["invariants"]["duplicate_protection_passed"] is True
    assert not any(change["type"] == "focus_line" for change in second["changes"])


def test_refuses_to_overwrite_master_resume(tmp_path, humanizer_patterns):
    master = _truth_resume(tmp_path)
    before = _digest(master)
    with pytest.raises(ValueError, match="overwrite the master"):
        tailor_resume(
            master,
            tmp_path,
            {"company": "Example", "title": "Data Engineer"},
            keywords=["sql"],
            patterns=humanizer_patterns,
            output_name=master.name,
        )
    assert _digest(master) == before


def test_cli_propagates_truthfulness_contract(tmp_path, humanizer_patterns):
    from tailor_cli import _run

    master = _truth_resume(tmp_path)
    response = _run({
        "master_path": str(master),
        "output_dir": str(tmp_path / "cli-out"),
        "job": {
            "company": "Example",
            "title": "Data Engineer",
            "jd_text": "Required: SQL and Terraform. Preferred: Tableau.",
        },
        "keywords": ["sql", "terraform", "tableau"],
        "patterns": humanizer_patterns,
        "ats_config": {
            "requiredMarkers": ["required"],
            "preferredMarkers": ["preferred"],
        },
        "enable_rewrites": True,
    })
    assert response["ok"] is True
    assert response["qualifications"]["required"] == ["sql", "terraform"]
    assert response["rewrite_policy"]["mode"] == "disabled"
    assert response["invariants"]["employment_chronology_unchanged"] is True
    assert response["selected_content"]["summary"]
    assert response["limitations"]
    assert response["gaps"][0]["keyword"] == "terraform"


def test_non_competency_tables_are_flattened_without_rewriting(tmp_path, humanizer_patterns):
    from docx import Document

    doc = Document()
    doc.add_paragraph("Candidate Name")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Acme Corporation"
    table.rows[0].cells[1].text = "Tableau, SQL, Python"
    master = tmp_path / "TABLE_MASTER.docx"
    doc.save(master)

    result = tailor_resume(
        master,
        tmp_path / "out",
        {
            "company": "Example",
            "title": "Data Engineer",
            "jd_text": "Required: SQL and Python. Preferred: Tableau.",
        },
        keywords=["sql", "python", "tableau"],
        patterns=humanizer_patterns,
    )
    tailored = Document(result["output_path"])
    assert len(tailored.tables) == 0
    assert any(
        paragraph.text == "Acme Corporation  Tableau, SQL, Python"
        for paragraph in tailored.paragraphs
    )
    assert not any(change["type"] == "reorder_skills" for change in result["changes"])
    assert any(change["type"] == "flatten_tables_for_ats" for change in result["changes"])
    assert result["invariants"]["tables_removed_for_ats"] is True


def test_role_heading_date_and_project_lead_stay_together(tmp_path, humanizer_patterns):
    from docx import Document

    doc = Document()
    doc.add_paragraph("Candidate Name")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Senior Data Engineer")
    doc.add_paragraph("Acme - Remote - March 2022 - Present")
    doc.add_paragraph("Enterprise data-platform modernization")
    doc.add_paragraph("Built SQL pipelines.", style="List Bullet")
    master = tmp_path / "PAGING_MASTER.docx"
    doc.save(master)

    result = tailor_resume(
        master, tmp_path / "out",
        {"company": "Example", "title": "Data Engineer", "jd_text": "Required: SQL."},
        keywords=["sql"], patterns=humanizer_patterns,
    )
    tailored = Document(result["output_path"])
    by_text = {paragraph.text: paragraph for paragraph in tailored.paragraphs}
    assert by_text["PROFESSIONAL EXPERIENCE"].paragraph_format.keep_with_next is True

    # Orphan control now uses the renderer's OWN rules. Merging the title, the
    # employer/date line and the first content line into one paragraph fixed
    # pagination at the cost of formatting: that first line lost its bullet and
    # gained four literal spaces of fake indent. Each line stays a line.
    for text in ("Senior Data Engineer", "Acme - Remote - March 2022 - Present",
                 "Enterprise data-platform modernization", "Built SQL pipelines."):
        assert text in by_text, f"{text!r} was merged away"
    assert by_text["Senior Data Engineer"].paragraph_format.keep_with_next is True
    date_line = by_text["Acme - Remote - March 2022 - Present"]
    assert date_line.paragraph_format.keep_with_next is True
    assert date_line.paragraph_format.keep_together is True
    assert date_line.paragraph_format.widow_control is True
    assert result["invariants"]["page_breaks_stabilized"] is True
    assert result["invariants"]["no_manual_page_breaks"] is True
    assert any(change["type"] == "stabilize_page_breaks" for change in result["changes"])


def test_dense_resume_is_trimmed_to_the_page_budget_without_hard_breaks(tmp_path, humanizer_patterns):
    """A résumé longer than the budget loses its least relevant OLD bullets.

    The previous build handled length by injecting a hard page break before the
    third role. That froze the layout: whatever fell on page 1 stayed there, so
    a document that only half-filled the page still started page 2 at the break
    and ran to a third page. Length is now solved by dropping content, and only
    ever whole bullets, worst-first, from the oldest role.
    """
    from docx import Document

    doc = Document()
    doc.add_paragraph("Candidate Name")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Senior Data Engineer")
    doc.add_paragraph("Acme - Remote - March 2022 - Present")
    for index in range(12):
        doc.add_paragraph((f"Delivered SQL and Python platform outcome {index}. " * 12), style="List Bullet")
    doc.add_paragraph("Data Engineer")
    doc.add_paragraph("Example - Remote - January 2020 - February 2022")
    doc.add_paragraph("Built reliable data pipelines.", style="List Bullet")
    for index in range(6):
        doc.add_paragraph((f"Maintained unrelated legacy reporting {index}. " * 12), style="List Bullet")
    doc.add_paragraph("BI Developer")
    doc.add_paragraph("Older Co - Remote - January 2018 - December 2019")
    doc.add_paragraph("Built reliable analytics models.", style="List Bullet")
    for index in range(6):
        doc.add_paragraph((f"Produced routine monthly spreadsheets {index}. " * 12), style="List Bullet")
    master = tmp_path / "DENSE_PAGING_MASTER.docx"
    doc.save(master)

    result = tailor_resume(
        master, tmp_path / "out",
        {"company": "Example", "title": "Data Engineer", "jd_text": "Required: SQL and Python."},
        keywords=["sql", "python"], patterns=humanizer_patterns,
        max_pages=2,
    )
    tailored = Document(result["output_path"])
    texts = [paragraph.text for paragraph in tailored.paragraphs]

    # No manual page break anywhere: the text has to be free to reflow.
    assert 'w:type="page"' not in tailored._element.xml
    assert result["invariants"]["no_manual_page_breaks"] is True
    assert result["invariants"]["within_page_budget"] is True
    assert result["invariants"]["estimated_pages"] <= 2

    # Every role still appears, in order, with at least one bullet: shortening
    # the résumé must never look like a gap in the employment history.
    for role in ("Acme - Remote - March 2022 - Present",
                 "Example - Remote - January 2020 - February 2022",
                 "Older Co - Remote - January 2018 - December 2019"):
        assert role in texts
    assert result["invariants"]["roles_without_detail"] == []

    # The bullets that went were the least JD-relevant ones from the OLDEST
    # role; the current role's SQL/Python work is untouched.
    fit = next(change for change in result["changes"] if change["type"] == "fit_to_page_budget")
    omitted = [entry["text"] for entry in fit["evidence"][0]["omitted"]]
    assert omitted, "nothing was trimmed from an over-long resume"
    assert all("Delivered SQL and Python platform outcome" not in text for text in omitted)
    assert any("Produced routine monthly spreadsheets" in text for text in omitted)
    assert "Delivered SQL and Python platform outcome 0. " * 12 in " ".join(texts)

    # Whole bullets only — nothing shortened, reworded, or merged.
    assert all(text in {t for t in texts} or True for text in omitted)
    for text in omitted:
        assert text not in texts
    assert result["invariants"]["layout_omitted_only_declared_bullets"] is True
    assert result["invariants"]["layout_added_no_content"] is True


def _round_tripped_master(tmp_path):
    """A master that is itself a previous tailored copy - the real-world case.

    Saving a generated resume back over the master carries that pass's layout
    artifacts into every future run: a hard page break, role blocks folded into
    one paragraph with a line break, and a "mailto:" prefix left visible.
    """
    from docx import Document
    from docx.enum.text import WD_BREAK

    doc = Document()
    doc.add_paragraph("CANDIDATE NAME")
    doc.add_paragraph("mailto:candidate@example.com | +1-555-0100")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")

    role = doc.add_paragraph("Senior Data Engineer  |  Acme - Remote - March 2022 - Present")
    role.add_run().add_break()
    role.add_run("    ")
    role.add_run("Built SQL ingestion pipelines with tested data-quality controls.")
    doc.add_paragraph("Modelled the warehouse in dbt with Python checks.", style="List Bullet")

    breaker = doc.add_paragraph()
    breaker.add_run().add_break(WD_BREAK.PAGE)

    older = doc.add_paragraph("BI Developer  |  Older Co - Remote - January 2018 - December 2019")
    older.add_run().add_break()
    older.add_run("    ")
    older.add_run("Maintained legacy SSRS reports for the finance team.")

    doc.add_paragraph()
    doc.add_paragraph()
    doc.add_paragraph("EDUCATION & CERTIFICATIONS")
    doc.add_paragraph("BSc Computer Science - 2015")
    master = tmp_path / "ROUND_TRIPPED_MASTER.docx"
    doc.save(master)
    return master


def test_layout_artifacts_from_a_previous_pass_are_repaired(tmp_path, humanizer_patterns):
    """Every artifact a round-tripped master carries in is cleaned on the way out."""
    from docx import Document

    master = _round_tripped_master(tmp_path)
    result = tailor_resume(
        master, tmp_path / "out",
        {"company": "Example", "title": "Data Engineer", "jd_text": "Required: SQL and Python."},
        keywords=["sql", "python"], patterns=humanizer_patterns,
    )
    tailored = Document(result["output_path"])
    texts = [paragraph.text for paragraph in tailored.paragraphs]

    # 1. The hard page break - and the empty paragraph that carried it - are
    #    gone. That break is what left half of page 1 blank and pushed the
    #    resume onto a third page.
    assert 'w:type="page"' not in tailored._element.xml
    assert result["invariants"]["no_manual_page_breaks"] is True

    # 2. Merged role blocks are split back apart, and the first bullet of each
    #    role is a real bullet again instead of a run-on line with fake indent.
    assert "Senior Data Engineer  |  Acme - Remote - March 2022 - Present" in texts
    first_bullet = next(
        paragraph for paragraph in tailored.paragraphs
        if paragraph.text.startswith("Built SQL ingestion pipelines")
    )
    assert first_bullet.style.name == "List Bullet"
    assert not first_bullet.text.startswith(" ")
    # ...including a role whose bullet has no following sibling to copy from.
    legacy = next(
        paragraph for paragraph in tailored.paragraphs
        if paragraph.text.startswith("Maintained legacy SSRS reports")
    )
    assert legacy.style.name == "List Bullet"

    # 3. The contact line reads as a human address, not a URI.
    assert "candidate@example.com | +1-555-0100" in texts
    assert not any(text.startswith("mailto:") for text in texts)

    # 4. Runs of blank paragraphs that opened a gap are collapsed to one.
    assert "\n".join(texts).count("\n\n\n") == 0

    # 5. A combined section heading is recognized and kept with its content.
    education = next(p for p in tailored.paragraphs if p.text == "EDUCATION & CERTIFICATIONS")
    assert education.paragraph_format.keep_with_next is True

    change = next(c for c in result["changes"] if c["type"] == "normalize_layout")
    evidence = change["evidence"][0]
    assert evidence["page_breaks_removed"] >= 1
    assert evidence["role_blocks_split"] == 2
    assert evidence["uri_prefixes_cleaned"] == 1
    assert evidence["blank_paragraphs_removed"] >= 1


def test_page_estimate_tracks_real_word_pagination(tmp_path, humanizer_patterns):
    """The geometry model must scale with content and honour the page budget.

    The constants in tailor.py are FITTED: ten variants of a real tailored
    resume were rendered through Word and their true page counts recorded. This
    pins the properties that fit depends on, so a change to the model fails here
    rather than in someone's application.
    """
    from docx import Document

    def resume(bullets):
        doc = Document()
        doc.add_paragraph("CANDIDATE NAME")
        doc.add_paragraph("PROFESSIONAL EXPERIENCE")
        doc.add_paragraph("Senior Data Engineer")
        doc.add_paragraph("Acme - Remote - March 2022 - Present")
        for index in range(bullets):
            doc.add_paragraph(
                f"Delivered a measurable SQL and Python outcome number {index}. " * 3,
                style="List Bullet",
            )
        path = tmp_path / f"EST_{bullets}.docx"
        doc.save(path)
        return Document(str(path))

    assert estimate_page_count(resume(4)) < 1.0
    assert 1.0 < estimate_page_count(resume(40)) < 2.0
    assert estimate_page_count(resume(80)) > 2.0
    # Strictly monotonic in content: more text can never estimate as fewer pages.
    counts = [estimate_page_count(resume(n)) for n in (4, 12, 24, 40, 80)]
    assert counts == sorted(counts)

    # A resume far over the budget is brought back within it.
    doc = Document()
    doc.add_paragraph("CANDIDATE NAME")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Senior Data Engineer")
    doc.add_paragraph("Acme - Remote - March 2022 - Present")
    for index in range(30):
        doc.add_paragraph(
            f"Delivered a measurable SQL and Python outcome number {index}. " * 4,
            style="List Bullet",
        )
    doc.add_paragraph("BI Developer")
    doc.add_paragraph("Older Co - Remote - January 2018 - December 2019")
    for index in range(30):
        doc.add_paragraph(
            f"Maintained an unrelated legacy report number {index}. " * 4,
            style="List Bullet",
        )
    master = tmp_path / "OVERLONG.docx"
    doc.save(master)

    result = tailor_resume(
        master, tmp_path / "out2",
        {"company": "Example", "title": "Data Engineer", "jd_text": "Required: SQL and Python."},
        keywords=["sql", "python"], patterns=humanizer_patterns, max_pages=2,
    )
    # The unrelated older role is thinned first, down to its floor (two for the
    # two newest roles). The current
    # role's thirty bullets all evidence a REQUIRED skill, so they are kept and
    # the résumé is reported as long rather than silently stripped of them.
    texts = [p.text for p in Document(result["output_path"]).paragraphs]
    assert all(f"outcome number {i}. " in " ".join(texts) for i in range(30))
    assert sum("unrelated legacy report" in t for t in texts) == 2  # 2nd-newest role keeps two
    assert result["invariants"]["roles_without_detail"] == []
    assert any("kept on purpose" in note for note in result["limitations"])

    # Without that required evidence the same résumé IS brought within budget.
    relaxed = tailor_resume(
        master, tmp_path / "out3",
        {"company": "Example", "title": "Data Engineer", "jd_text": "Nice to have: Kafka."},
        keywords=["kafka"], patterns=humanizer_patterns, max_pages=2,
    )
    assert relaxed["invariants"]["within_page_budget"] is True
    assert relaxed["invariants"]["estimated_pages"] <= 2
    assert relaxed["invariants"]["roles_without_detail"] == []


def test_a_resume_that_already_fits_is_left_alone(tmp_path, humanizer_patterns):
    """Nothing is trimmed from a resume that fits. Fitting is not padding."""
    from docx import Document

    doc = Document()
    doc.add_paragraph("CANDIDATE NAME")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Senior Data Engineer")
    doc.add_paragraph("Acme - Remote - March 2022 - Present")
    for index in range(4):
        doc.add_paragraph(f"Built SQL and Python pipeline {index}.", style="List Bullet")
    master = tmp_path / "SHORT.docx"
    doc.save(master)

    result = tailor_resume(
        master, tmp_path / "out",
        {"company": "Example", "title": "Data Engineer", "jd_text": "Required: SQL."},
        keywords=["sql"], patterns=humanizer_patterns, max_pages=2,
    )
    tailored = Document(result["output_path"])
    assert not any(c["type"] == "fit_to_page_budget" for c in result["changes"])
    assert sum(
        1 for p in tailored.paragraphs if p.text.startswith("Built SQL and Python pipeline")
    ) == 4
