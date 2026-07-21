# Han 2025 AOX 推荐能力 Benchmark

本目录提供一个**可直接运行的独立 benchmark**，用于测试 EnzymeMiner Pro 从参考序列出发，能否把 Han 等人在 2025 年实验验证的高活性 alcohol oxidase（AOX）候选推荐到前列。

> 论文：Han et al., *Sequence and taxonomic feature evaluation facilitated the discovery of alcohol oxidases*，DOI `10.1016/j.synbio.2025.04.014`。

## 1. 这个 benchmark 回答什么问题

主要问题不是“能否严格复现论文每一级漏斗的序列数量”，而是：

1. 已知高活性酶是否进入最终候选集；
2. 如果没有进入，是在 HMM 检索、长度过滤、残基评分、聚类、网络还是预测阶段丢失；
3. 如果进入，产品默认推荐策略能否将其排到前面；
4. 去掉网络簇大小、参考相似度、性质预测等因素后，排序是否改善或恶化；
5. kcat/Km、可溶性和 Tm 服务是否真正为高活性候选提供有效信息。

本 benchmark **不把未实验测试的候选当作低活性或阴性**。因此可以报告已知目标的全局名次，但不能把全局未标注候选用于计算“全局 precision”。

## 2. 两种运行模式

### A. Fixed recommendation benchmark（推荐优先，建议先运行）

固定使用作者仓库中的 SSN 上下文：358 个节点，其中 19 个参考节点、339 个可推荐候选。该模式跳过 HMM 搜索与上游筛选漂移，只测试：

- 实际性质预测 API；
- 实际推荐 API；
- 默认方法及消融方法；
- 23 个有实验标签的新候选中的排序表现；
- 6 个高活性目标在 339 个候选中的全局名次。

这是判断“推荐模块本身是否有效”的主测试。

### B. Reference-to-recommendation benchmark（端到端诊断）

从 Han 的 21 条活性 AOX 参考序列开始，依次运行：

```text
参考序列导入
→ CD-HIT 参考去冗余
→ MAFFT
→ hmmbuild
→ hmmsearch
→ HMM 分数/长度过滤
→ 残基规则评分
→ 候选 CD-HIT
→ 相似性网络
→ kcat/Km、可溶性、Tm 预测
→ 候选推荐
→ 六个高活性目标逐阶段追踪
→ 自动评估
```

默认搜索库是作者数据构造的 393 条受控上下文。它适合测试脚本和定位系统损失，但**不是完整 UniProt reference proteome 的严格复现**。如需更接近真实发现流程，应通过 `--target-fasta` 提供冻结版本的完整数据库 FASTA。

端到端运行默认把 `tr|ACCESSION|ENTRY` / `sp|ACCESSION|ENTRY` 的首 token 显式规范为 accession，并将该事实和新 FASTA 哈希写入 manifest。这是因为当前网络构建代码会把共享的 `tr`/`sp` token 误判为同一节点，从而大量吞掉序列。该规范化是 benchmark 的**声明性 workaround**，不是软件原生支持 raw UniProt ID 的证据。使用 `--preserve-target-ids` 可专门测试并暴露这个兼容性缺陷；脚本会检查“CD-HIT 预期候选节点数”和“实际网络候选节点数”，不允许静默通过。

## 3. 目录结构

```text
benchmarks/aox_han_2025/
├── configs/                 # benchmark、推荐方法和端到端流程参数
├── data/
│   ├── references/          # 21 条参考序列及作者图中的 19 个参考节点
│   ├── universe/            # 339/358/393 序列上下文
│   ├── labels/              # 31、23 和 6 条实验标签
│   ├── metadata/            # 作者序列分数、HMM 分数、分类等
│   └── network/             # 固定 SSN 的 nodes/edges
├── provenance/              # 来源 commit、文件哈希和许可证
├── results/                 # 每次运行单独生成一个目录
└── scripts/                 # 运行、评估、追踪、doctor 和校验脚本
```

## 4. 运行机器要求

运行脚本的机器需要：

- Python 3.10 或更高版本；脚本本身只使用标准库；
- EnzymeMiner Pro 后端已经启动；
- 后端可调用 `cd-hit`、`mafft`、`hmmbuild`、`hmmsearch`；
- 端到端网络方法默认需要 `mmseqs`；
- kcat/Km、solubility、Tm 服务已启动并由后端正确配置；
- benchmark 脚本和后端必须能访问后端返回的 task `workDir`。最简单方式是在同一台电脑运行。

后端常用环境变量（以项目实际 `.env` 和部署设置为准）：

```bash
export CATAPRO_URL='http://...'
export SOLUBILITY_URL='http://...'
export TM_URL='http://...'
export EC_URL='http://...'       # EC 不是本 benchmark 的硬要求
export API_KEY='...'             # 如果后端启用了 API key
export AOX_BENCH_API_URL='http://127.0.0.1:8787'
```

**科学结果禁止使用 mock prediction。** 如果服务离线，应修复服务，而不是将 mock 输出当作 benchmark 结果。

## 5. 复制到另一台电脑

建议复制整个项目，以保证 benchmark 与当前后端 API 版本一致。如果只复制 benchmark 文件夹，还必须确保目标电脑上的 EnzymeMiner Pro 后端接口与本项目一致。

```bash
cd /path/to/enzymeminer-pro
python3 benchmarks/aox_han_2025/scripts/aoxbench.py verify-data
python3 benchmarks/aox_han_2025/scripts/aoxbench.py doctor \
  --api-url http://127.0.0.1:8787
```

`doctor` 检查静态数据、命令行工具、后端和预测服务。若只想检查本地数据和工具：

```bash
python3 benchmarks/aox_han_2025/scripts/doctor.py --skip-api
```

## 6. 运行 fixed benchmark

```bash
python3 benchmarks/aox_han_2025/scripts/aoxbench.py run-fixed \
  --api-url http://127.0.0.1:8787 \
  --force-prediction
```

或直接运行：

```bash
python3 benchmarks/aox_han_2025/scripts/run_fixed_benchmark.py \
  --api-url http://127.0.0.1:8787
```

默认要求 `cataPro,solubility,tm` 在线。调试 API 时可跳过预测：

```bash
python3 benchmarks/aox_han_2025/scripts/run_fixed_benchmark.py \
  --api-url http://127.0.0.1:8787 \
  --skip-prediction \
  --require-services ''
```

该调试结果不能用于声称性质预测有效。

## 7. 运行端到端 benchmark

### 7.1 受控 393 序列上下文

```bash
python3 benchmarks/aox_han_2025/scripts/aoxbench.py run-reference \
  --api-url http://127.0.0.1:8787 \
  --force-prediction
```

如果要测试原始 UniProt pipe ID 是否被系统正确处理：

```bash
python3 benchmarks/aox_han_2025/scripts/aoxbench.py run-reference \
  --api-url http://127.0.0.1:8787 \
  --preserve-target-ids \
  --skip-prediction \
  --require-services ''
```

当前实现很可能因网络节点数量不一致而将该 run 标记为失败；这正是需要暴露的软件缺陷。

### 7.2 保留精确 accession 的端到端敏感性分析

默认 `.85` CD-HIT 只保留每个簇的代表序列，可能在推荐前删除已知高活性 accession。为了回答“如果不在这里提前删除，后续推荐能否把它排到前面”，可额外运行：

```bash
python3 benchmarks/aox_han_2025/scripts/aoxbench.py run-reference \
  --api-url http://127.0.0.1:8787 \
  --candidate-identity 1.0 \
  --force-prediction
```

这是**敏感性分析**而不是论文 `.85` 流程的原样结果。必须与默认 run 并列报告：

- 默认 run 衡量产品当前去冗余策略会不会提前丢掉目标；
- identity 1.0 run 在尽量保留精确 accession 后，隔离测试下游网络、性质预测和推荐。

后端输出文件仍命名为 `candidates_cdhit85.fasta`，即使使用了 override；真实 identity 以 `run_manifest.json` 的 `effective_pipeline_config` 为准。

### 7.3 用户提供的冻结数据库

```bash
python3 benchmarks/aox_han_2025/scripts/aoxbench.py run-reference \
  --api-url http://127.0.0.1:8787 \
  --target-fasta /absolute/path/frozen_reference_proteomes.fasta \
  --force-prediction \
  --timeout 14400
```

必须记录数据库来源、下载日期、release/version、物种范围以及文件 SHA256。脚本会自动记录输入 FASTA 的路径与 SHA256，但不会替你补齐数据库生物学来源。

## 8. 输出文件

每次运行写入：

```text
results/<run-name>/
├── api/                       # 每个 API 的原始 JSON 响应
├── artifacts/                 # 端到端关键中间文件与哈希
├── rankings/                  # 每种方法的完整排序
├── selections/                # 每种方法的 Top 3/5/10/20 实际选择
├── predictions.csv            # 格式化预测结果
├── methods_manifest.json      # 方法参数、候选数和选择结果
├── target_stage_trace.tsv     # 端到端模式的六目标逐阶段追踪
├── evaluation.json            # 完整机器可读指标
├── method_summary.tsv         # 推荐方法摘要
├── report.md                  # 自动生成的人类可读报告
└── run_manifest.json          # 模式、task、服务、状态、输入哈希和错误信息
```

端到端运行即使中途失败，也会尽量保存 `run_manifest.json`、已完成的 API 响应和已有中间产物，便于定位损失。

## 9. 如何看结果

优先看：

1. `report.md` 中 `product_default` 的 Top-K 命中数、nDCG、Spearman 和最佳酶全局名次；
2. `default_no_hard_cluster_filter` 是否明显优于 `product_default`；若是，说明硬性排除 singleton/小簇可能伤害发现能力；
3. `no_cluster_size` 是否改善高活性目标排名；若是，说明大网络组分偏好可能过强；
4. `similarity_only` 与 `properties_only` 的差异；
5. `target_stage_trace.tsv` 中高活性目标最早在哪一步消失；
6. `network_integrity` 是否通过；不通过时，后续排名无效；
7. `property_evaluation` 的覆盖率。低覆盖率不能被平均分掩盖。

在当前 `.85` candidate CD-HIT 配置下，精确的高活性 accession 可能只是某个簇的非代表成员，因而在推荐前被删除。脚本会把这种情况标记为 `passed_residue_scoring=1`、`passed_candidate_clustering=0`。这不能被解释成“推荐模块没有找到它”，而应批判性地报告为：系统以代表序列替代原酶后，已经失去对实验高活性酶**精确推荐**的能力。fixed 模式因此仍是评价推荐公式的主 benchmark。

特别注意：当前默认推荐权重中，参考相似度与网络簇大小占较大比重，可能偏向“已知样、密集簇”的保守候选，而 Han 的高活性结果集中于此前较少报道的分类群。若消融显示去掉簇大小后更好，应将其视为产品默认策略的真实弱点，而不是解释成数据异常。

## 10. 重跑与恢复

- 默认每次创建新的 task 和新的 result 目录，避免覆盖旧结果；
- `--run-name` 必须是尚不存在的目录名；
- `--task-id` 仅用于你确认是空任务的情况；不要在有旧产物的 task 上运行，否则缓存或遗留网络文件可能污染结果；
- 预测服务短暂失败后，建议创建新 run，并使用 `--force-prediction`；
- 失败 run 不会自动从中间点续跑，保留的 artifacts 用于诊断，不应手工拼接成“完整成功结果”。

## 11. 大致耗时

耗时主要取决于预测服务吞吐量和相似性网络计算：

- fixed 模式：339 条候选的预测加多种排序；
- 受控端到端模式：393 条数据库规模，通常显著小于全蛋白组数据库；
- 完整 reference proteome：HMM 命中数量及最终候选数量可能大幅增加，网络 all-vs-all 和预测服务可能成为主要瓶颈。

脚本默认单个 HTTP 长步骤超时为 7200 秒，可用 `--timeout` 调整端到端运行器。

## 12. 已知数据不一致

论文正文报告 357 个最终候选；截至本 benchmark 固定的作者仓库 commit `01a96d96b5bc7f87ff696ee50ab445555c49e6bf`（commit 日期 2026-01-16）：

- 作者图文件有 358 个节点；
- 完整 all-pairs 边表涉及 360 个序列 ID；
- 本 benchmark 固定使用可明确追溯的 358 节点图，不会静默改成“357”。

这意味着本 benchmark 是对可获得作者数据制品的可追溯重建，而不是对论文数字的强行一致化。

## 13. 数据来源与许可证

静态数据的来源 commit、SHA256、数量和 Apache-2.0 许可证副本见：

```text
provenance/manifest.json
provenance/AUTHOR_REPOSITORY_LICENSE.txt
```

方法学与解释限制见 [METHODS.md](METHODS.md)。
