# EnzyMiner Pro Task Report

{{report_metadata_table}}

> This report summarizes artifacts already saved for the selected task. Generating it does not rerun searches, alignments, similarity calculations, property predictions, or recommendations; it therefore reflects the saved task state at report-generation time.

## 1. Executive Summary

This section is a result snapshot for quickly seeing how far the workflow progressed and how many candidates remain. Counts describe computational records, not experimentally validated successes.

{{executive_summary}}

### Workflow Funnel

The funnel shows how sequence or record counts change from reference input to final recommendation. Adjacent counts need not decrease monotonically: an alignment may include references, clustering may deduplicate sequences, and unrun steps produce no count.

{{workflow_funnel_table}}

## 2. Method Overview and Reading Guide

{{methodology_overview}}

## 3. Workflow Status

This table indicates whether each step has a saved status or output. “Completed” means that completion state or an output artifact was detected; it does not mean that the result has been manually reviewed or experimentally validated. “Partial” usually means that some steps have not run or artifacts are missing.

{{workflow_status_table}}

## 4. Reference Input

Reference sequences define the protein family or functional neighborhood being sought. They are the basis for HMM/BLAST searches, reference-similarity metrics, and downstream recommendation. Reference quality and representativeness directly affect the results: a narrow set may bias one subfamily, while an overly broad set may reduce functional specificity.

{{reference_section}}

## 5. Sequence Search and Filtering

Search first expands the candidate set, then applies saved thresholds to remove records that clearly fail the criteria. In general, **higher HMM score/bit score, identity, and coverage indicate stronger sequence evidence, while a lower E-value indicates a lower chance-match expectation**. Stricter thresholds can nevertheless discard distant, novel homologs. For a Compare workflow, this section describes source tasks and set operations rather than a new database search.

{{search_section}}

## 6. Multiple Sequence Alignment

Multiple sequence alignment places homologous positions in common columns, providing a coordinate system for active-site rules and conservation review. Alignment length is a column count that includes gaps introduced by insertions; it is not the original length of any one protein. Poor alignment or an unsuitable reference can map a rule to the wrong biological position.

{{alignment_section}}

## 7. Active Site Scoring

This step checks amino acids at saved alignment coordinates. Each rule specifies a position, allowed residues, and a positive or negative score; matching rule scores are summed and compared with the pass threshold. **A higher total means only that a sequence better matches the current rule set**. It is not enzyme activity and does not replace structural analysis or experimental validation.

{{scoring_section}}

## 8. Clustering

Clustering reduces redundancy and shows how candidates group. A higher identity threshold usually creates stricter, smaller clusters; a lower threshold merges more sequences. A large cluster means that a sequence type is common in the current data, not automatically that its function is more reliable. A singleton can be noise or a novel branch worth investigating.

{{clustering_section}}

## 9. Sequence Similarity Analysis

Network nodes are reference or candidate sequences, and edges indicate sequence pairs meeting the saved similarity criterion. **Higher similarity means closer sequences**. A higher network threshold retains fewer edges and usually fragments the graph; a lower threshold connects more sequences into large components. Network proximity supports relative comparison but does not by itself prove identical function.

{{similarity_section}}

## 10. Property Prediction

Property predictions provide computational evidence for candidate ranking. Interpret every value together with provenance: `real` is returned by a real prediction service, `mock` is demonstration-only, and `missing`/`failed` indicates unavailable or failed output. Report statistics and scientific scoring use only `real` values.

As general directions, when substrate and units are comparable, higher kcat, lower Km, and higher kcat/Km are usually favorable; higher solubility is usually favorable; and Tm must be interpreted relative to the desired operating temperature. In the recommendation property score, **closeness to the target Tm is favorable—not unconditionally higher Tm**. These values are model predictions, not measurements.

{{prediction_section}}

## 11. Manual Filtering

Manual filtering is a **hard gate** before recommendation: a candidate either satisfies the conditions and enters the pool or is excluded; filtering does not create a priority score. With AND logic, every condition must match. Conditions involving predicted properties accept only `real` values, so missing, failed, or Mock values cannot satisfy them.

{{manual_filter_section}}

## 12. Candidate Recommendation

Recommendation is not simply the global highest-score list. The system first calculates a five-component weighted score and then performs proportional or round-robin diversity selection across network components. The details below explain each metric, its direction, parameter effects, and why the selected set may differ from the global top N by score.

{{recommendation_section}}

## 13. Data Integrity and Warnings

This section flags count mismatches, missing artifacts, prediction-provenance issues, and other conditions that may affect interpretation. A warning does not necessarily mean task failure, but it should be reviewed before citing conclusions or planning experiments.

{{warnings_section}}

## 14. Generated Artifacts

The artifact inventory lists files actually inspected by this report, with record counts and timestamps. Summary values come from these files. For sequence-level auditing, inspect the corresponding CSV/FASTA rather than relying only on truncated report tables.

{{artifacts_section}}

## 15. Reproducibility Information

These fields identify the task, software version, report template, and prediction provenance. Reproduction also requires the task directory, saved parameter-state files, reference inputs, and versions of external databases or prediction services.

{{reproducibility_section}}

---

Generated by EnzyMiner Pro {{software_version}} · Apache-2.0
