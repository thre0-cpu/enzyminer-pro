# Task report templates

The task report is rendered from the editable Markdown templates in this directory:

- `task-report.en.md`: English report
- `task-report.zh.md`: Chinese report

The frontend does not expose template editing. Edit these files directly and generate the report again; the backend reads the selected template for every export request, so a restart is not required. Existing generated reports are not changed automatically.

## Available placeholders

Each placeholder is replaced with a Markdown fragment generated from the selected task's existing artifacts:

- `{{report_metadata_table}}`
- `{{executive_summary}}`
- `{{workflow_funnel_table}}`
- `{{methodology_overview}}`
- `{{workflow_status_table}}`
- `{{reference_section}}`
- `{{search_section}}`
- `{{alignment_section}}`
- `{{scoring_section}}`
- `{{clustering_section}}`
- `{{similarity_section}}`
- `{{prediction_section}}`
- `{{manual_filter_section}}`
- `{{recommendation_section}}`
- `{{warnings_section}}`
- `{{artifacts_section}}`
- `{{reproducibility_section}}`
- `{{software_version}}`

You may change headings, explanatory text, ordering, or omit sections. Keep a placeholder wherever the corresponding generated content should appear. Unknown placeholders are retained in the output and reported as warnings so template mistakes are visible.

## What to edit for each kind of change

The report has two layers:

1. **Editable report wording and structure** — edit `task-report.zh.md` or `task-report.en.md` in this directory. This is the normal place to rewrite section introductions, add interpretation guidance, rename/reorder headings, or remove a section.
2. **Generated tables and task-specific values** — edit `backend/taskReport.mjs`. Each placeholder is populated by a correspondingly named variable near the end of `buildTaskReport()`. For example:
   - `search_section` is built in `searchSection`;
   - `prediction_section` is built in `predictionSection`;
   - `recommendation_section` is built in `recommendationSection`;
   - `warnings_section` is built from the `warnings` array.

Additional export presentation is controlled separately:

- PDF/print HTML colors, fonts, spacing, tables, and page rules: `markdownToHtml()` in `backend/taskReport.mjs`.
- Word (`.docx`) Markdown parsing and document styles: `backend/generate_report_docx.py`.
- Report file names and API export behavior: `reportFileName()` in `backend/taskReport.mjs` and the `/api/report/export` route in `backend/server.mjs`.

The backend reads the Markdown template again for every export request, so wording/structure edits take effect on the next generated report without restarting the service. JavaScript or Python generator changes require restarting the backend. Previously generated reports are never rewritten automatically.
