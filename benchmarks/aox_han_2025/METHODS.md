# AOX Han 2025 Benchmark 方法学说明

## 1. 评价目标

该 benchmark 将“发现流程”拆成两个问题：

1. **候选召回问题**：从参考序列和数据库开始，高活性酶是否能通过 HMM、长度、残基规则、去冗余和网络构建进入最终候选池？
2. **候选推荐问题**：在候选已经存在的前提下，系统是否将实验高活性酶排在用户可实际测试的 Top-K 中？

用户最终承担的是合成、表达和湿实验成本，所以第二个问题是主问题。上游漏斗数量只用于定位失败来源，不能替代推荐质量。

## 2. 为什么采用两种模式

### Fixed author graph

固定作者 SSN 后，HMMER 版本、数据库 release、物种组成、结构域预筛选和作者仓库变化不再影响候选集合。由此可以把失败更明确地归因于：

- 性质预测覆盖不足或预测错误；
- 推荐公式偏置；
- 硬性簇大小过滤；
- 多样性选择策略；
- 参考相似度偏好。

### Reference-to-recommendation

端到端模式更接近真实使用方式，但结果同时受到数据库和每一级阈值影响。如果一个高活性目标在 HMM 阶段未被召回，就无法用最终“未排名”判断推荐公式本身不好。因此必须同时输出逐阶段 trace。

默认 393 序列库是受控上下文，不等同于完整数据库重跑。完整数据库实验应单独冻结 FASTA 和 provenance。

### ID 规范化与原生兼容性诊断

当前网络节点去重会把 pipe-formatted UniProt ID 的共享 token（例如 `tr`）纳入等价判断，可能把许多不同 accession 合并。默认 benchmark 在送入后端前将首 token 规范为 accession，并记录原始/规范化 FASTA 哈希，以便主端到端诊断继续运行。同时提供 `--preserve-target-ids`：不做 workaround，并以网络候选节点计数 invariant 暴露原生兼容性错误。两种运行回答不同问题，不能把规范化后的成功误称为产品已修复 raw ID 缺陷。

## 3. 实验标签队列

作者工作流共包含 31 个实验测试条目，其中包含 8 个参考样或参考样控制。主评价队列排除这些控制，保留 23 个新候选。

高活性定义为实验比活性严格大于 `1000 mU/mg`，得到 6 个目标：

| Accession | Activity (mU/mg) |
|---|---:|
| A0A4U6X6L6 | 8647.0 |
| A0A423XHQ7 | 7946.0 |
| A0A5N5JXS7 | 5997.7 |
| A0A0E0SDM0 | 4087.3 |
| A0A4Z1KC62 | 3170.8 |
| A0A5B1QN96 | 1269.8 |

### 不将未测试候选当作阴性

339 个可推荐候选中只有一小部分有实验标签。未测试只表示未知，不表示无活性。因此：

- 可报告六个已知目标的全局 rank；
- 可在 23 个有标签候选内部计算排序指标；
- 不报告以全部 339 个候选为分母的“全局 precision”；
- 不以未测试候选构造虚假阴性训练集。

## 4. 端到端参数

参考集合为 21 条已知活性 AOX。主要参数保存在 `configs/reference_pipeline.json`：

- 参考 CD-HIT identity：0.90；
- HMM hit 长度：600–700 aa；
- HMM score 下限：0，用于受控上下文中观察召回，避免人为用高阈值提前删掉目标；
- 残基规则锚定参考：`AAB57849.1`；
- 残基评分阈值：33.5；
- 候选 CD-HIT identity：0.85；该后端步骤只保留代表序列，因此会删除簇内非代表 accession；
- 网络相似性方法：MMseqs2；
- 网络包含 reference links。

残基规则编码 Han 工作流使用的 FAD、底物结合、催化位点和 C 端 PTS 特征。脚本通过后端的自定义 scoring rules API 执行，而不是在 benchmark 外部另写一套评分器。

为区分“`.85` 去冗余造成的目标丢失”和“下游推荐失败”，允许预先声明 `--candidate-identity 1.0` 敏感性分析。它尽量只合并完全相同序列，使已知 accession 有机会进入下游，但不属于默认流程结果。默认与敏感性 run 必须成对解释，不能只选择更好看的一个。

## 5. 推荐方法和消融

`configs/methods.json` 固定以下方法：

- `product_default`：当前产品默认权重，且最小组分大小为 2；
- `default_no_hard_cluster_filter`：相同权重但保留 singleton；
- `no_properties`：去掉性质预测；
- `no_cluster_size`：去掉网络组分大小；
- `no_taxonomy_diversity`：去掉组分分类多样性；
- `similarity_only`：只用参考相似度；
- `properties_only`：只用真实性质预测；
- `default_round_robin`：默认打分加严格组分 round-robin 选择。

这些消融不是为了在 23 条标签上寻找“最佳权重”，而是为了暴露当前产品策略依赖什么，以及哪个因素可能系统性压低高活性候选。

必须避免：在全部 23 条标签上调权重，再把同一批 23 条称为独立测试集。如果后续要优化权重，应预先定义 train/validation/test 或增加其他酶家族的外部 benchmark。

## 6. 指标

### 6.1 有标签队列内部排序

- High-activity hits@3/5/10/20；
- precision@K 和 recall@K，仅限 23 条有标签队列；
- mean experimental activity@K；
- nDCG@K，relevance 使用 `log1p(activity)`，降低极端高值支配；
- Spearman：推荐顺序与实验活性的等级相关；
- score coverage：23 条中实际获得推荐分数的数量。

### 6.2 全局已知目标恢复

- 六个高活性目标各自的全局 rank；
- 最高活性目标 `A0A4U6X6L6` 的全局 rank；
- 实际 Top-K selection 中命中的已知高活性目标数。

全局 rank 可以回答“用户翻到第几名才能看到目标”，但不能证明排在目标前面的未测试候选为假阳性。

### 6.3 性质预测诊断

- 可溶性预测覆盖率；
- 可溶性 AUROC、AUPRC 和 Brier score；
- kcat/Km 可用覆盖率；
- 预测 `kcat/Km` 与实验比活性的 Spearman。

实验比活性不等于严格的 kcat/Km，底物、测定条件和表达纯化因素也不同。因此相关性是诊断性指标，不是等价验证。

### 6.4 基线

- uniform random，固定随机种子、10,000 次；
- taxonomy-class-stratified random；
- HMM score；
- 论文 sequence score；
- 论文直接 taxonomy score；
- 最大/平均参考相似度。

论文的 taxonomy score 是文献知识驱动的分类优先级；产品中的 taxonomy diversity 是网络组分内分类多样性。两者含义不同，不能互换或宣称复现。

## 7. 六目标逐阶段追踪

端到端模式生成 `target_stage_trace.tsv`：

- `present_in_database`；
- `hmm_retrieved`；
- `passed_length_filter`；
- `present_in_scoring_table`；
- `passed_residue_scoring`；
- `passed_candidate_clustering`；
- `present_in_network`；
- `received_prediction`；
- `received_recommendation_score`；
- `global_rank`。

ID 匹配支持精确 accession、`sp|ACC|...`/`tr|ACC|...`、区间后缀和常见 UniProt entry-name 形式。仍建议数据库 FASTA 以 accession 作为首个 token，避免不可恢复的自定义 ID。

## 8. 关键偏差与局限

1. **回顾性选择偏差**：23 个实验候选本身是作者经过多步规则筛选和人工选择后的集合，不是从 339 个候选均匀抽样。
2. **标签稀疏**：大多数候选未知，不能计算真实全局精确率。
3. **论文数据制品不一致**：正文 357、当前图 358、all-pairs ID 360。benchmark 保留可追溯的具体制品。
4. **数据库漂移**：完整 UniProt 或 reference proteome 会持续变化；不冻结 release 无法严格比较。
5. **预测任务错配**：CataPro 的预测目标与论文比活性不是完全同一实验量。
6. **性质服务覆盖偏差**：预测失败可能不是随机的，长序列、非典型序列或远缘序列更可能缺失；缺失不能默认填成中性高分。
7. **保守推荐偏差**：参考相似度和大组分权重可能偏爱已知样序列，压低新颖但高活性的远缘候选。
8. **小样本不确定性**：6 个高活性阳性不足以支持细粒度权重优化或普适结论。
9. **代表序列替代偏差**：CD-HIT 保留的代表序列未必继承被删除成员的实验高活性。仅凭高序列相似度不能把活性标签转移给代表序列。
10. **FASTA ID 兼容性缺陷**：raw `tr|...`/`sp|...` ID 可能在网络阶段发生错误节点合并；默认规范化只是 benchmark workaround。
11. **单家族外推有限**：AOX 上有效不代表其他酶家族有效。最终应扩展到 3–5 个机制、家族规模和标签结构不同的酶家族。

## 9. 合格结论与不合格结论

### 可以支持

- 在固定作者候选上下文中，某方法把多少已知高活性 AOX 排入 Top-K；
- 某个高活性目标在端到端流程的哪一步丢失；
- 去除组分大小或硬过滤后，已知目标排名是否改善；
- 性质服务在有标签队列上的覆盖率和诊断性相关性。

### 不能支持

- “系统发现了新的高活性酶”，除非有新的湿实验验证；
- “Top-K 其余候选都是假阳性”；
- “在 AOX 上有效，所以对所有酶家族都有效”；
- 使用 mock prediction 得出任何生物学性能结论；
- 在同一批 23 条上调参并宣称独立测试性能。
