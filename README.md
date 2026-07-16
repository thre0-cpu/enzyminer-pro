# EnzyMiner Pro

当前版本：**V1.0.3**

高通量酶挖掘全栈工具平台，支持 **HMMER**、**BLAST** 和 **Compare** 三种模块，涵盖从参考序列管理到 Cytoscape 网络可视化和候选序列智能推荐的完整流水线。

- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Express API (`backend/server.mjs`)
- **Pipeline scripts**: Python helpers (`scripts/`)

---

## V1.0.3 稳定性更新

- 相似性计算与性质预测统一为“状态检查 → 使用已有结果 / 计算 / 更新”的交互，不再因进入页面或加载结果而隐式启动昂贵计算。
- 相似性结果增加输入指纹和方法校验，可识别 `ready`、`stale`、`legacy`、`missing` 状态；强制重算收纳到 More actions 并要求确认。
- 性质预测缓存按候选序列、SMILES、预测器地址和结果完整性校验；读取缓存使用纯 GET，不会重新调用 EC、kcat/Km、Sol、Tm 服务。
- 保留旧版 CSV 和 mock 预测兼容性，并补充后端集成回归测试。

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
| 8 | **Network Push** | 按相似性阈值推送网络到 Cytoscape 桌面端（CyREST），或在浏览器中查看网络并下载 PNG/SVG 图像 |
| 9 | **候选推荐** | 支持系统自动推荐与预测性质人工筛选，可勾选、全选并保存 FASTA/完整 CSV |

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
| 8 | **Network Push** | 推送到 Cytoscape，或在浏览器中查看并下载 PNG/SVG 网络图 |
| 9 | **候选推荐** | 支持系统自动推荐与预测性质人工筛选，可勾选、全选并保存 FASTA/完整 CSV |

### Compare 模块（网络对比）

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | **导入网络** | 从已有任务导入节点和边数据 |
| 2 | **合并网络** | 合并多个来源的网络数据 |
| 3 | **推送到 Cytoscape** | 推送合并后的网络到 Cytoscape |
| 4 | **Similarity** | 跨网络相似性计算 |
| 5 | **候选推荐** | 基于多维加权评分的候选序列自动推荐 |

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

该脚本会自动启动后端 API 和前端预览服务，启动后访问：
- **前端**: http://localhost:3000
- **后端**: http://localhost:8787/api/health

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

Vite 开发服务器默认仅监听 `http://127.0.0.1:3000`，并自动代理 `/api` 到 `http://127.0.0.1:8787`。

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
- `http://localhost:3000` (Frontend)
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
- `POST /api/network/compute-similarity` — 相似性计算
- `POST /api/network/push-cytoscape` — 推送到 Cytoscape
- `POST /api/network/predict-metrics` — 性质预测（kcat/solubility/Tm），结果缓存到 `predicted_metrics.csv`
- `POST /api/network/recommend-candidates` — 候选序列推荐（六维加权，含 Strategy 1 预测评分）
- `POST /api/network/filter-predicted-candidates` — 对全部已完成性质预测的候选进行多条件人工筛选、排序和分页
- `POST /api/network/export-recommended-fasta` — 导出推荐候选 FASTA
- `POST /api/network/export-recommended-csv` — 导出推荐候选完整 CSV（序列、HMM/UniProt/taxonomy 元数据、网络评分及预测性质）
- `POST /api/network/highlight-cytoscape` — 在 Cytoscape 中高亮选中节点

## 8. 候选推荐系统

### Strategy 1: Property Prediction Score（性质预测评分）

在 Recommendation 页面新增「Strategy 1」卡片，可一键对网络中所有候选序列运行以下四个预测：

| 预测指标 | 说明 | 评分逻辑 | 外部服务 |
|----------|------|----------|----------|
| **kcat/Km** | 催化效率 | 值越大越好（min-max 归一化） | CataPro (可选) |
| **Solubility** | 溶解度概率 | 值越大越好（min-max 归一化） | PLM_Sol (可选) |
| **EC Number** | 酶分类号（Top-3） | 展示预测结果与置信度 | CLEAN (可选) |
| **Tm** | 熔解温度 (°C) | 越接近「目标温度」越好（高斯衰减） | TmPred (可选) |

四个指标通过**可拖拽权重条**（默认各 1/3）实时调整占比，并计算加权综合评分（`predictedScore`）。

> **EC Number 鼠标悬停提示**：将鼠标悬停在 EC Number 列上，会浮窗显示 Top-3 EC 预测结果及其置信度百分比。

**参数配置：**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| kcat 权重 | 33% | kcat/Km 预测值占比 |
| Solubility 权重 | 33% | 溶解度预测值占比 |
| Tm 权重 | 33% | 熔解温度占比 |
| Tm 目标温度 | 60°C | 序列 Tm 越接近此值得分越高 |
| 底物 SMILES | _(空)_ | 用于 CataPro kcat/Km 预测，留空使用 mock 值 |

**预测服务状态**：Dashboard 的健康检查面板会显示各预测服务（kcat/Km、Solubility、EC Number、Tm）的在线/离线状态及服务地址。Prediction 页面标题旁也会以绿/灰圆点显示各服务状态。

**进度条与 ETA**：进度按“候选序列 × 预测器”工作单元统计。CataPro、PLM_Sol、CLEAN 每个 HTTP 批次完成后更新一次，Tm 每条完成后更新一次；界面同时显示各预测器的条目/批次数和预计剩余时间。服务在批次内部没有进度接口，因此界面不会伪造批次内部百分比。结果缓存到任务目录下的 `predicted_metrics.csv`；"Recompute All" 可强制重新计算。

**批量调用与回退**：CataPro、PLM_Sol、CLEAN 分别调用 `/predict/batch`，默认每个应用层批次 64 条（`PREDICTION_BATCH_SIZE`，最大 256）。单条校验失败或整个批次请求失败时，仅对应结果使用确定性 mock 回退并记录 `source=mock`，下次运行会在真实服务在线时重试。Tm 暂无批量接口，仍调用 `/predict`。外部服务地址由 `CATAPRO_URL`、`SOL_URL`、`EC_URL`、`TM_URL` 配置，默认端口分别为 8003、8004、8000、8005；单批请求超时由 `PREDICTION_REQUEST_TIMEOUT_MS` 配置，默认 600000 ms。

### Strategy 2: Comprehensive Recommendation（综合推荐）

候选序列通过六维加权评分公式进行排序：

$$
\text{Score} = w_1 \cdot \overline{S}_{\text{ref}} + w_2 \cdot S_{\text{ref,max}} + w_3 \cdot \hat{C} + w_4 \cdot D_{\text{tax}} + w_5 \cdot \text{NetComp} + w_6 \cdot \text{PredictedScore}
$$

| 维度 | 说明 | 默认权重 |
|------|------|----------|
| `avgRefSimilarity` | 与所有参考序列的平均相似性 | 0.28 |
| `maxRefSimilarity` | 与最相似参考序列的相似性 | 0.20 |
| `clusterSize` | 所在聚类的归一化大小 | 0.12 |
| `networkComponentSize` | 所在网络连通分量的归一化大小 | 0.12 |
| `taxonomyDiversity` | 所在聚类的分类多样性 | 0.08 |
| `predictedScore` | Strategy 1 的综合预测评分 | **0.20** |

> 原有 5 个指标权重整体按比例缩小到 80%，新增 `predictedScore` 默认占 20%。如果该任务还没跑过 Strategy 1，该权重贡献为 0（页面有黄色提示）。

### 多样性选择（Cluster Round-Robin）

为避免推荐结果集中在少数大聚类中，采用聚类轮询策略：
1. 按最高得分对聚类排序
2. 每轮从每个聚类依次取一个候选
3. 循环直至达到 Top N 数量

### Temperature 采样

- **T = 0**（默认）：确定性选择，每个聚类内取最高分
- **T > 0**：使用 softmax 温度采样（$P(i) = \frac{e^{s_i/T}}{\sum_j e^{s_j/T}}$），引入可控随机性

### 可配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 最小 Cluster 大小 | 2 | 过滤孤立节点（cluster_size < 阈值的候选被排除） |
| Top N | 50 | 推荐候选数量 |
| Temperature | 0 | 采样温度（0 = 确定性，越大越随机） |
| Network Connectivity Threshold | 85% | 网络连通性阈值 |
| Weights | 见上表 | 六维权重（通过可视化拖拽条调节，自动归一化至总和 = 1） |

### 权重调节 UI（WeightBar）

前端提供多段式彩色比例条，六种颜色分别对应六个评分维度：
- 🟣 **靛蓝** — avgRefSimilarity
- 🔵 **天蓝** — maxRefSimilarity
- 🟢 **翠绿** — clusterSize
- 🟣 **紫色** — networkComponentSize
- 🟡 **琥珀** — taxonomyDiversity
- 🩷 **粉色** — predictedScore

通过拖拽分隔线调整权重比例，「恢复默认」按钮一键重置。

### Manual Filtering（人工筛选）

Recommendation 页面在系统自动推荐之外提供独立的人工筛选区域，数据范围是当前任务中**所有已经完成 Strategy 1 性质预测的候选序列**，不受自动推荐 Top N 限制。

- 可动态添加最多 20 条条件，当前版本按 **AND** 组合
- EC 条件默认匹配 `ec_top1`、`ec_top2`、`ec_top3` 任意一个，也可限定只匹配 Top 1、Top 2 或 Top 3
- 文本字段支持包含、不包含、等于、不等于、开头匹配；可筛选 ID、EC、UniProt、description 和各级分类学字段
- 数值字段支持 `>`、`≥`、`<`、`≤`、`=` 和区间；可筛选 sequence length、HMM/BLAST 指标、kcat、Km、kcat/Km、Solubility、Tm 和 Predicted Score
- 结果支持服务端排序和分页，并提供「选择当前页」「选择全部筛选结果」「清空选择」及逐条勾选
- 选中结果可保存为 FASTA 或完整 CSV；筛选条件、排序、每页条数和选择状态按任务保存到浏览器本地存储

系统自动推荐结果同样支持分页、逐条勾选、选择当前页、选择全部推荐结果、清空选择，并且只保存当前选中的序列。新计算出的推荐结果默认全部选中，以保持原有的一键保存体验。

### 附加功能

- **浏览器网络图下载**：在线 D3/Cytoscape.js 网络图可直接保存为 PNG 或 SVG；仅导出图本身，不包含页面工具栏和提示框
- **FASTA/CSV 保存**：系统推荐和人工筛选结果均可先勾选，再通过 Save Selected 下拉保存 FASTA 或 CSV。CSV 包含完整序列、长度、HMM/BLAST 分数、UniProt/分类学/描述字段、网络与推荐评分（如适用），以及 kcat、Km、kcat/Km、溶解度、Tm、EC 和预测来源
- **Cytoscape 高亮**：一键在 Cytoscape 桌面端选中/高亮推荐的候选节点（通过 CyREST Commands API）
- **状态持久化**：推荐结果和所有参数（包括 Strategy 1 的权重、Tm 目标温度、网络连通性阈值等）在页面刷新后自动恢复
- **全局错误边界**：前端增加了 `GlobalErrorBoundary`，捕获渲染阶段的运行时错误（如缓存数据缺少新字段），展示友好的错误提示和重载按钮，避免白屏
- **防御性数据标准化**：Recommendation 结果在加载时自动对缺失字段做防御性处理，避免旧缓存数据导致 `.toFixed()` 调用 undefined 崩溃

## 9. 项目结构

```
enzyminer-pro/
├── backend/
│   └── server.mjs          # Express 后端（所有 API）
├── scripts/
│   ├── ncbi_annotate.py     # NCBI Entrez 分类注释（BLAST 用）
│   └── uniprot_fill.py      # UniProt 注释（HMMER 用）
├── src/
│   ├── App.tsx              # 主 React 组件（HMMER + BLAST + Compare 三模块）
│   ├── RecommendationPanels.tsx # 系统推荐选择表格与人工筛选共享组件
│   └── api.ts               # 前端 API 客户端
├── index.html
├── package.json
├── start.sh                 # 一键启动脚本
├── stop.sh                  # 停止脚本
├── vite.config.ts
└── tailwind.config.js
```
