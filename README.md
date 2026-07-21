# EnzyMiner Pro

当前版本：**V1.1.1**

高通量酶挖掘全栈工具平台，支持 **HMMER**、**BLAST** 和 **Compare** 三种模块，涵盖从参考序列管理到 Cytoscape 网络可视化和候选序列智能推荐的完整流水线。

- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Express API (`backend/server.mjs`)
- **Pipeline scripts**: Python helpers (`scripts/`)

---

## V1.1.1 更新

- 修复新建任务时邮箱和 Property Prediction 的 Substrate 跨任务预填充问题。
- 增加页面顶部左右箭头，可在相邻流水线页面之间快速切换。
- 修复任务切换后的结果隔离，并完善下载、重跑、对齐和预测流程的稳定性。

## V1.1.0 更新

- **Similarity Network 交互选择**：新增 Navigate / Select Nodes 模式，可点击节点选择或取消选择，支持选择当前可见节点、全部已加载节点、清空选择，并导出选中节点的 FASTA 或完整 CSV。
- **网络布局持久化**：可冻结并保存 D3/Cytoscape.js 节点坐标、缩放和平移状态；再次打开任务时恢复布局。节点集合发生变化时会提示 `partial` / `stale`，不会把旧坐标错误套到新节点。
- **Analysis 页面拆分**：左侧 `ANALYSIS` 导航按 `Similarity Network → Property Prediction → Recommendation` 排列。性质预测是独立页面，不再嵌套在 Recommendation 中；人工条件筛选仍是推荐前的可选候选池过滤。
- **Task Report**：左侧新增 `REPORT → Task Report`，可将当前任务已有结果汇总为中文或英文报告，并保存为 Markdown、PDF 或 Word；生成报告不会重新启动任何计算或预测。
- **离线 Example Case**：内置 12 条 synthetic candidates + 2 条 references 的预计算示例，可直接演示网络选择、布局恢复、性质表、筛选和推荐，不调用外部预测服务，也不启动昂贵计算。
- **Help & About / 发布信息**：新增帮助页，显示版本、构建 commit、构建日期和许可证；项目采用 Apache-2.0，第三方组件说明见 `THIRD_PARTY_NOTICES.md`。
- **稳定性与科学安全**：相似性计算和性质预测继续使用显式状态检查与缓存指纹，页面加载、预览和读取已有结果不会隐式启动计算；旧 CSV 与 V1.0 任务仍可读取，但普通任务中的旧 mock 预测缓存会被判定为失效，mock 只保留给内置 Example/Demo。

---

## 模块总览

### BLAST 模块（基于序列相似性搜索）

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | **Reference** | 从 UniProt 获取参考序列（支持手动上传/粘贴），生成 `ref.csv` + `ref.fasta` |
| 2 | **Build DB** | 使用 `makeblastdb` 构建本地 BLAST 数据库，或选择 NCBI 远程搜索模式 |
| 3 | **BLAST Search** | 运行 `blastp` 搜索，支持多 query 合并策略（best-evalue / union），过滤命中结果，**NCBI 分类注释**（查询 NCBI Entrez 自动填充 kingdom/phylum/class/species） |
| 4 | **Alignment** | 使用 MAFFT 进行多序列比对，支持轻量残基着色、共识序列、列范围预览和结果 FASTA 下载 |
| 5 | **Scoring** | 基于比对位点的自定义打分规则，支持 JSON 导入/导出，阈值过滤 |
| 6 | **Clustering** | CD-HIT 聚类（默认 85% identity），去冗余 |
| 7 | **Similarity** | 全序列 pairwise 相似性计算（global/local alignment），进度条实时显示 |
| Analysis | **Similarity Network** | 推送到 Cytoscape，或在浏览器中选择/导出节点、下载 PNG/SVG、冻结并恢复布局 |
| Analysis | **Property Prediction** | 独立运行或复用 kcat/Km、Solubility、Tm 和 EC 预测结果 |
| Analysis | **Recommendation** | 可选候选池筛选、自动排序、勾选、导出和网络高亮 |
| Report | **Task Report** | 从当前任务已有产物生成中英文 Markdown、PDF 或 Word 报告，不重新计算 |

### HMMER 模块（基于隐马尔可夫模型搜索）

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | **Reference** | 从 UniProt 获取参考序列 |
| 2 | **HMM Build** | MAFFT 多序列比对 → `hmmbuild` 构建 HMM profile |
| 3 | **EBI Search** | 提交 HMMER 搜索至 EBI API，下载命中结果，**UniProt 注释**（批量查询 UniProt 获取 taxonomy + 序列长度） |
| 4 | **Alignment** | MAFFT 比对参考 + 候选序列，支持轻量残基着色、共识序列、列范围预览和结果 FASTA 下载 |
| 5 | **Scoring** | 自定义位点打分规则，支持 JSON 导入/导出 |
| 6 | **Clustering** | CD-HIT 聚类去冗余 |
| 7 | **Similarity** | Pairwise 相似性计算 |
| Analysis | **Similarity Network** | 推送到 Cytoscape，或在浏览器中选择/导出节点、下载 PNG/SVG、冻结并恢复布局 |
| Analysis | **Property Prediction** | 独立运行或复用 kcat/Km、Solubility、Tm 和 EC 预测结果 |
| Analysis | **Recommendation** | 可选候选池筛选、自动排序、勾选、导出和网络高亮 |
| Report | **Task Report** | 从当前任务已有产物生成中英文 Markdown、PDF 或 Word 报告，不重新计算 |

### Compare 模块（网络对比）

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | **导入网络** | 从已有任务导入节点和边数据 |
| 2 | **合并网络** | 合并多个来源的网络数据 |
| 3 | **推送到 Cytoscape** | 推送合并后的网络到 Cytoscape |
| 4 | **Similarity** | 跨网络相似性计算 |
| 5 | **Property Prediction** | 对合并网络独立运行或复用性质预测 |
| 6 | **Recommendation** | 可选候选池筛选和多维自动推荐 |
| 7 | **Task Report** | 汇总 Compare 任务已有网络、预测和推荐结果并导出报告 |

---

## 1. 环境要求

- **Node.js** 18+
- **Python** 3.10+（推荐使用 conda 环境）
- **外部生物信息学工具**（必须在 PATH 中，否则 `/api/health` 检测会显示 `false`）:
  - `cd-hit`
  - `mafft`
  - `hmmbuild`, `hmmsearch`（HMMER3）
  - `blastp`, `makeblastdb`（BLAST+）
  - `mmseqs`（MMseqs2，默认 pairwise 相似性计算引擎，通过 `MMSEQS_BIN` 可指定路径）
- **Cytoscape 桌面端**（可选，用于网络可视化推送）:
  - 需要安装 [Cytoscape](https://cytoscape.org/) 并启用 CyREST API（默认端口 `1234`）
  - 网络推送和高亮功能依赖 Cytoscape 运行

## 2. 安装依赖

### 2.1 安装 Node.js 依赖

```bash
cd enzyminer-pro
npm install
```

### 2.2 安装生物信息学工具

**方式一：apt（Ubuntu / Debian）**

```bash
sudo apt update && sudo apt install -y hmmer cd-hit mafft ncbi-blast+
```

> `mmseqs2` 不在 apt 源中，需要单独安装：
> ```bash
> # 推荐：用 conda 安装
> conda install -y -c bioconda mmseqs2
>
> # 或者：下载预编译二进制
> wget https://github.com/soedinglab/MMseqs2/releases/download/18-85ce/mmseqs-linux-sse41.tar.gz
> tar xzf mmseqs-linux-sse41.tar.gz
> sudo cp mmseqs/bin/mmseqs /usr/local/bin/
> ```

**方式二：conda（推荐，一次性全部搞定）**

```bash
conda create -n mining -y python=3.11
conda activate mining
conda install -y -c bioconda -c conda-forge hmmer cd-hit mafft blast mmseqs2 pandas biopython requests tqdm
```

> ⚠️ 环境名**必须叫 `mining`**（`start.sh` / `scripts/start_services.sh` 中硬编码了自动检测路径 `~/miniconda3/envs/mining/bin/python` 等），否则启动脚本不会自动使用该环境，需要手动设置 `PIPELINE_PYTHON`。

**方式三：macOS (Homebrew)**

```bash
brew install hmmer cd-hit mafft blast mmseqs
```

安装后验证：

```bash
hmmbuild -h && hmmsearch -h && cd-hit -h && mafft -h && blastp -h && makeblastdb -h && mmseqs -h
```

全部有输出说明安装成功。

### 2.3 安装 Python 依赖

如果没用 conda 统一安装，手动安装 Python 包：

```bash
pip install -r requirements.txt
```

如果 Python 或 bioinfo 工具装在 conda `mining` 环境中，`start.sh` 会自动检测并使用，无需手动设置 `PIPELINE_PYTHON`。如需手动指定：

```bash
export PIPELINE_PYTHON=~/miniconda3/envs/mining/bin/python
```

## 3. 一键启动（推荐）

```bash
bash start.sh
```

该脚本会自动启动后端 API 和前端预览服务。前端模块使用独立 URL：

- **Home**: http://localhost:3000/home
- **HMMER**: http://localhost:3000/hmmer
- **BLAST**: http://localhost:3000/blast
- **Compare**: http://localhost:3000/compare
- **Help & About**: http://localhost:3000/help
- **后端健康检查**: http://localhost:8787/api/health

访问旧根地址 `http://localhost:3000/` 时会自动规范化为 `/home`。模块之间采用完整页面导航，以清理上一模块遗留的轮询和任务加载状态；任务进度仍从任务目录和浏览器本地状态恢复。

停止服务：

```bash
bash stop.sh
```

## 4. 开发模式启动（分别启动前后端）

**后端 API：**

```bash
npm run dev:api
```

如果需要指定 conda 环境中的 Python，设置 `PIPELINE_PYTHON` 环境变量：

```bash
# 示例：使用 conda 环境中的 Python
export PIPELINE_PYTHON=~/miniconda3/envs/mining/bin/python
npm run dev:api
```

**前端（另开一个终端）：**

```bash
npm run dev
```

Vite 开发服务器默认仅监听 `http://127.0.0.1:3000`，并自动代理 `/api` 到 `http://127.0.0.1:8787`。Vite 开发服务器和 `vite preview` 均支持直接打开 `/home`、`/hmmer`、`/blast`、`/compare`、`/help`。

如果将 `dist/` 部署到 Nginx、Apache 或其他静态服务器，需要把这些前端路径回退到 `index.html`。Nginx 示例：

```nginx
location / {
    try_files $uri $uri/ /index.html;
}

location /api/ {
    proxy_pass http://127.0.0.1:8787;
}
```

**可选环境变量：**

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_HOST` | `127.0.0.1` | 后端监听地址 |
| `API_PORT` | `8787` | 后端端口 |
| `FRONTEND_HOST` | `127.0.0.1` | 前端监听地址 |
| `FRONTEND_MODE` | `dev` | `start.sh` 的前端模式；`preview` 会先重新构建，避免旧 `dist` |
| `PIPELINE_ROOT` | 工作区根目录 | Pipeline 根目录 |
| `PIPELINE_TASKS_ROOT` | `{PIPELINE_ROOT}/tasks` | 任务数据目录 |
| `PIPELINE_PYTHON` | 自动探测 `mining` 环境，否则 `python3` | Python 解释器路径 |
| `API_KEY` | _(空)_ | 本机/受信任单用户环境的可选 API 密钥 |
| `VITE_API_KEY` | _(空)_ | 浏览器请求使用的同一密钥；会进入前端包，不是秘密 |
| `ALLOWED_ORIGINS` | 本机两个 3000 端口来源 | 允许访问后端的浏览器来源列表 |

如需从受信任内网访问，可设置：

```bash
export API_HOST=0.0.0.0
export FRONTEND_HOST=0.0.0.0
export ALLOWED_ORIGINS=http://192.168.1.20:3000
```

请将示例 IP 替换为运行本项目主机的实际内网地址。`API_KEY` 只用于本机/受信任单用户场景的便利保护，不构成多用户认证体系。

## 5. WSL 外部访问（Windows 浏览器）

直接在 Windows 浏览器访问：
- `http://localhost:3000/home` (Frontend Home)
- `http://localhost:8787/api/health` (Backend)

若 localhost 不通，在 PowerShell (管理员) 中执行端口转发：

```powershell
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=127.0.0.1
netsh interface portproxy add v4tov4 listenport=8787 listenaddress=0.0.0.0 connectport=8787 connectaddress=127.0.0.1
```

## 6. 任务管理

- 每个模块（HMMER/BLAST/Compare）有独立的任务空间和默认任务（`hmmer-default` / `blast-default`）
- 任务数据存储在 `tasks/{taskId}/` 目录
- Pipeline 状态文件：`hmmer_state.json` / `blast_state.json`

## 7. 主要 API 端点

### 通用
- `GET /api/health` — 健康检查
- `GET /api/tasks` — 列出所有任务
- `POST /api/tasks` — 创建任务
- `GET /api/runtime/logs` — 获取运行日志和进度
- `GET /api/examples` — 列出内置离线示例
- `POST /api/examples/load` — 复制预计算示例为独立任务；不会启动计算
- `POST /api/report/export` — 从当前任务已有产物生成中英文 Markdown、PDF 打印页或 Word 报告；不会启动计算

### BLAST 模块
- `POST /api/blast/build-db` — 构建 BLAST 数据库
- `POST /api/blast/search` — 运行 BLAST 搜索
- `POST /api/blast/filter` — 过滤命中结果
- `POST /api/blast/annotate` — NCBI 分类注释（自动填充 taxonomy + 补全 nodes.csv）
- `GET /api/blast/page` — 分页浏览命中结果

### HMMER 模块
- `POST /api/reference/fetch` — 获取参考序列
- `POST /api/hmm/build` — 构建 HMM
- `POST /api/search/run` — 提交 EBI 搜索
- `POST /api/search/ebi/uniprot-fill` — UniProt 注释

### 共享步骤
- `POST /api/scoring/prepare-alignment` — 生成 `scoring_input_auto.mafft.fasta` MAFFT 比对文件
- `GET /api/scoring/alignment-preview` — 分页、分列加载轻量比对预览（单个窗口最多 240 列）
- `GET /api/scoring/alignment-download` — 下载生成的 `scoring_input_auto.mafft.fasta`
- `POST /api/scoring/run` — 打分
- `POST /api/clustering/run` — CD-HIT 聚类
- `GET /api/network/similarity-status` — 只读检查相似性缓存状态
- `POST /api/network/compute-similarity` — 显式计算或按请求复用相似性结果
- `POST /api/network/browser-graph` — 读取浏览器网络图节点与阈值过滤后的边
- `GET|PUT|DELETE /api/network/layout` — 读取、保存或清除任务级网络布局
- `POST /api/network/push-cytoscape` — 推送到 Cytoscape
- `GET /api/network/prediction-status` — 只读检查性质预测缓存状态
- `GET /api/network/predicted-metrics` — 只读加载已验证的性质预测结果
- `POST /api/network/predict-metrics` — 批量性质预测或增量补算，结果缓存到 `predicted_metrics.csv`
- `POST /api/network/filter-predicted-candidates` — 预览可选候选池过滤、排序和分页
- `POST /api/network/recommend-candidates` — 在全部候选或已应用过滤候选池上运行五维自动推荐
- `POST /api/network/export-recommended-fasta` — 导出推荐候选 FASTA
- `POST /api/network/export-recommended-csv` — 导出推荐候选完整 CSV（序列、HMM/UniProt/taxonomy 元数据、网络评分及预测性质）
- `POST /api/network/highlight-cytoscape` — 在 Cytoscape 中高亮选中节点

## 8. Similarity Network（浏览器网络图）

浏览器网络图支持 D3 和 Cytoscape.js 两种轻量渲染器，不要求 Cytoscape 桌面端在线。

### 节点选择与导出

- **Navigate**：拖动节点、平移和缩放网络，不改变选择。
- **Select Nodes**：点击节点进行选择/取消选择；手工选择使用蓝色边框，推荐高亮使用金色边框。
- 支持搜索节点 ID、选择当前可见节点、选择全部已加载节点和清空选择。
- 选中节点可导出为 FASTA 或完整 CSV。CSV 会合并序列、HMM/BLAST 来源元数据、UniProt/分类信息、网络字段和已缓存的预测性质。
- 当前选择按任务保存在浏览器 `localStorage`，刷新页面后可恢复。

### 布局冻结与持久化

- **Freeze & Save Layout**：保存当前节点坐标、renderer、zoom 和 pan 到任务目录下的 `network_layout.json`，并冻结节点位置。
- **Unlock**：允许继续拖动或运行力导向布局，但不会删除已保存快照。
- **Restore Saved Layout**：恢复最近保存的布局。
- **Run Automatic Layout**：重新计算布局，只有再次保存后才覆盖持久化快照。
- **Clear Saved Layout**：主动删除任务的布局快照。
- 布局状态包括 `ready`、`partial`、`stale`、`missing`。当网络节点变化时，只恢复仍然存在的节点坐标并明确提示，不会静默错配。

网络图仍可下载 PNG 或 SVG；导出只包含图本身，不包含页面工具栏和提示框。

## 9. Analysis：Property Prediction 与 Recommendation

HMMER 和 BLAST 工作流的左侧 `ANALYSIS` 分组包含三个并列页面，并按以下顺序排列：

1. **Similarity Network**
2. **Property Prediction**：独立运行或读取 kcat/Km、Solubility、Tm 和 EC 预测。
3. **Recommendation**：可选地先过滤候选池，再对候选池自动评分、排序和选择。

打开 Property Prediction 页面只会检查缓存状态，不会自动启动预测。Recommendation 页面也不会隐式运行预测；如果没有来源为 `real` 的可用性质指标，仍可运行推荐，但 `predictedScore` 不提供性质证据并按 0 计入推荐公式。Compare 工作流同样将 Property Prediction 与 Recommendation 展示为两个独立步骤。

### Property Prediction

| 预测指标 | 说明 | 评分逻辑 | 外部服务 |
|----------|------|----------|----------|
| **kcat/Km** | 催化效率 | 对 `kcat / Km` 取对数后归一化，值越大越好 | CataPro（可选） |
| **Solubility** | 溶解度概率 | 值越大越好 | PLM_Sol（可选） |
| **EC Number** | 酶分类号 Top-3 | 用于展示和条件筛选，不直接进入 Predicted Score | CLEAN（可选） |
| **Tm** | 熔解温度 (°C) | 越接近目标温度越好 | Tm 服务（可选） |

kcat/Km、Solubility 和 Tm 通过可拖拽权重条合并为 `predictedScore`；EC Top-3 及置信度可在表格中查看。归一化只使用来源为 `real` 的值；对单个候选缺失的性质指标，会在该候选仍可用的真实指标之间重新归一化子权重，同时用 `propertyCoverage` 显示原始性质权重中有多少得到了真实预测支持。

- 普通 **Run Property Prediction** 会复用输入与上下文匹配的缓存，仅补算缺失或失效的预测器结果。
- **Recompute All** 位于更多操作中，用于用户明确要求的全量重算。
- CataPro、PLM_Sol、CLEAN 使用 `/predict/batch`；应用层默认每批 64 条（`PREDICTION_BATCH_SIZE`，最大 256）。
- 进度按“候选序列 × 预测器”真实工作单元统计，并显示已完成批次、耗时和 ETA；服务没有批次内部进度接口时不会伪造百分比。
- 普通生产任务**不会**回退到合成 mock：服务未配置/离线时记录 `missing`，请求失败或返回无效结果时记录 `failed`；只有内置 Example/Demo 可使用 `mock`，且 mock 不参与归一化、性质筛选或推荐。
- 每项指标在页面和 CSV 中记录 `real`、`mock`、`missing` 或 `failed` 来源状态。没有真实性质证据时，`predictedScore` 为空、`propertyCoverage=0`，在推荐总分中该维贡献为 0。
- 缓存文件为 `predicted_metrics.csv` 和 `predicted_metrics.meta.json`，状态包括 `ready`、`stale` 和 `missing`。当前缓存上下文同时记录预测器 URL 与模式（`real` / `mock` / `unavailable`）；旧版本或不安全的模式会失效，普通任务的离线缓存会在真实服务恢复后转为 stale 以便补算，而已经得到的 `real` 结果在服务暂时离线时仍保持可用，不会被缺失值覆盖。

预测服务地址由 `CATAPRO_URL`、`SOL_URL`、`EC_URL`、`TM_URL` 配置，默认端口分别为 8003、8004、8000、8005；超时由 `PREDICTION_REQUEST_TIMEOUT_MS` 配置，默认 600000 ms。

### Optional Candidate Pool Filters

人工筛选现在是 Recommendation 的可选前置步骤，而不是与自动推荐平行的第二套最终流程。

- 没有有效筛选条件时，**Run Recommendation** 使用网络中的全部候选序列。
- 点击 **Apply Filters** 后，有效条件定义新的推荐候选池；自动推荐只对匹配序列进行评分和 Top N 选择。
- 条件变化但尚未 Apply 时，不会悄悄改变已应用的候选池。
- 性质条件筛选只接受来源为 `real` 的指标；`mock`、`missing`、`failed` 和未预测值均按缺失处理，不能满足 kcat、Km、Solubility、Tm、EC 或 Predicted Score 条件。
- 最多可添加 20 条条件，当前 UI 按 AND 组合。EC 可匹配 Top-1/2/3 任意项或指定排名。
- 文本字段支持包含、不包含、等于、不等于和开头匹配；数值字段支持 `>`、`≥`、`<`、`≤`、`=` 和区间。
- 可筛选 sequence length、HMM/BLAST 指标、UniProt/分类学字段、kcat、Km、kcat/Km、Solubility、Tm、EC 和 Predicted Score。
- 筛选预览支持服务端排序、分页、选择当前页、选择全部匹配结果、清空选择，并可独立导出 FASTA/CSV。

### Automatic Recommendation

候选序列按五维加权评分：

$$
\text{Score} = w_1 \cdot \overline{S}_{\text{ref}} + w_2 \cdot S_{\text{ref,max}} + w_3 \cdot \hat{C} + w_4 \cdot D_{\text{tax}} + w_5 \cdot \text{PredictedScore}
$$

| 维度 | 说明 | 默认权重 |
|------|------|----------|
| `avgRefSimilarity` | 与全部参考节点边的平均相似性 | 0.28 |
| `maxRefSimilarity` | 与最相似参考节点的相似性 | 0.20 |
| `clusterSize` | 指定 Connectivity Threshold 下所在网络连通分量的归一化大小 | 0.24 |
| `taxonomyDiversity` | 所在连通分量中 class 的归一化多样性 | 0.08 |
| `predictedScore` | 仅由真实 kcat/Km、Solubility、Tm 组成的综合评分；没有真实性质证据时贡献为 0，并由 `propertyCoverage` 标明覆盖度 | 0.20 |

参数包括 Minimum Cluster Size、Top N、Selection Strategy、Network Connectivity Threshold（默认 85%）、Temperature 和五维 WeightBar。所有权重会自动归一化到总和 1。

- **Proportional**：按各连通分量候选数分配 Top N 名额。
- **Round-robin**：在各连通分量间轮流选择，强调跨分量覆盖。
- **Temperature = 0**：确定性选择；大于 0 时使用 softmax 温度采样。
- 推荐结果支持分页、逐条勾选、选择当前页、选择全部、清空选择、导出 FASTA/完整 CSV，以及在浏览器网络图或 Cytoscape 桌面端高亮。
- 筛选条件、推荐参数、推荐结果和选择状态按任务持久化；输入条件变化会使旧推荐结果失效，避免把旧排序误当成新结果。

## 10. Task Report

HMMER 和 BLAST 工作流左侧新增独立入口 `REPORT → Task Report`；Compare 工作流在页面末尾提供相同的报告保存面板。报告生成器只读取当前任务目录中已经存在的状态文件和结果文件，**不会**隐式运行搜索、MAFFT、打分、聚类、相似性计算、性质预测、筛选或推荐。

前端仅提供：

- 报告语言：**中文** / **English**；
- 保存格式：**Markdown (`.md`)**、**PDF**、**Word (`.docx`)**；
- 一个统一的 **Save Report** 按钮。

PDF 使用浏览器原生打印能力：点击保存后会打开排版后的报告和打印对话框，在 Destination/目标打印机中选择 **Save as PDF / 另存为 PDF**。这样不需要额外安装 Chromium、Puppeteer、LaTeX 或系统级 PDF 引擎。Word 文件由 Python 标准库直接生成，不依赖 `python-docx`。

报告会尽可能汇总：任务元数据、工作流漏斗和步骤状态、Reference、Search & Filter、Alignment、Active Site Scoring、Clustering、Similarity Network、Property Prediction、Manual Filtering、Recommendation、数据一致性警告、产物清单和可复现性信息。缺少中间文件的未完成任务也可以生成报告，相应章节会明确标记为不可用。

中英文模板是仓库中的普通 Markdown 文件，可直接编辑：

```text
report-templates/task-report.zh.md
report-templates/task-report.en.md
```

模板占位符说明见 `report-templates/README.md`。每次生成报告时后端都会重新读取模板，因此修改模板后无需改前端；重新点击保存即可使用新模板。生成的 `.md`、打印用 `.html` 和 `.docx` 文件同时保存在当前 `tasks/{taskId}/` 目录，便于任务归档。

如果只想修改章节标题、说明文字、顺序或增删章节，改上述 Markdown 模板即可；如果要修改占位符生成的动态表格、指标定义、推荐公式说明或字段列，则修改 `backend/taskReport.mjs` 中 `buildTaskReport()` 内对应的 `searchSection`、`predictionSection`、`recommendationSection` 等变量。PDF/打印样式在同文件的 `markdownToHtml()`，Word 样式与 Markdown 解析在 `backend/generate_report_docx.py`。更完整的“改什么文件”对照表见 `report-templates/README.md`。

如流水线使用了特殊 Python 启动器，可通过 `REPORT_PYTHON` 单独指定 Word 生成器使用的 Python 可执行文件；默认复用 `PIPELINE_PYTHON` / `PYTHON_BIN` / `python3`。

## 11. Help & About 与离线 Example Case

首页和 Help & About 页面提供 **Load Example Case**。后端会把 `examples/v1.1-small/` 复制成一个独立 HMMER 任务，并加载预计算的相似性 CSV、mock 性质结果和保存布局：

- 12 条 synthetic candidates、2 条 synthetic references、53 条边；
- 不访问 UniProt、EBI、预测服务或其他外部网络；
- 不启动 MAFFT、MMseqs2、pairwise alignment 或性质预测；
- 示例中的 mock 是合成的演示数据，只用于软件交互和回归测试；它不参与科学归一化、性质筛选或推荐，不是生物学 benchmark，也不能解释为实验结果。

Help & About 同时说明工作流、缓存状态、网络操作、离线服务行为、本机/受信任内网部署边界，并显示 `version`、`commit`、`build date` 和 `license`。

## 12. 项目结构

```
enzyminer-pro/
├── backend/
│   ├── server.mjs          # Express 后端（所有 API）
│   ├── taskReport.mjs      # 只读聚合任务产物并渲染中英文报告
│   └── generate_report_docx.py # 无第三方依赖的 Word 生成器
├── scripts/
│   ├── ncbi_annotate.py     # NCBI Entrez 分类注释（BLAST 用）
│   └── uniprot_fill.py      # UniProt 注释（HMMER 用）
├── src/
│   ├── App.tsx              # 主 React 组件（HMMER + BLAST + Compare）
│   ├── NetworkGraph.tsx      # D3/Cytoscape.js 网络选择、导出与布局持久化
│   ├── RecommendationPanels.tsx # 推荐选择表格与候选池筛选组件
│   ├── TaskReportPanel.tsx  # 报告语言、格式选择与保存面板
│   ├── HelpAbout.tsx         # Help & About / Example Case 页面
│   └── api.ts                # 前端 API 客户端
├── examples/v1.1-small/      # synthetic + mock 离线预计算示例
├── report-templates/         # 可直接编辑的中英文 Markdown 报告模板
├── LICENSE                   # Apache License 2.0
├── THIRD_PARTY_NOTICES.md    # 第三方软件、模型和数据资源说明
├── index.html
├── package.json
├── start.sh                 # 一键启动脚本
├── stop.sh                  # 停止脚本
└── vite.config.ts
```

## 13. 版本与许可证

- 当前应用版本：**1.1.1**
- 构建日期：**2026-07-16**
- 项目原始代码和文档：**Apache License 2.0**，完整文本见 `LICENSE`
- 第三方工具、模型、权重、数据库和服务继续受各自许可证与使用条款约束，见 `THIRD_PARTY_NOTICES.md`

`/api/health` 会返回当前后端版本和许可证；前端首页与 Help & About 会显示构建时注入的版本、commit 和构建日期。
