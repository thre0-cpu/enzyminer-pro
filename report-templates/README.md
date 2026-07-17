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
