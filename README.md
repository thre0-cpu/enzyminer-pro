# EnzyMiner Pro

高通量酶挖掘全栈工具平台，支持 **HMMER**、**BLAST** 和 **Compare** 三种模块，涵盖从参考序列管理到 Cytoscape 网络可视化和候选序列智能推荐的完整流水线。

- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Express API (`backend/server.mjs`)
- **Pipeline scripts**: Python helpers (`scripts/`)

---

## 模块总览

### BLAST 模块（基于序列相似性搜索）

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | **Reference** | 从 UniProt 获取参考序列（支持手动上传/粘贴），生成 `ref.csv` + `ref.fasta` |
| 2 | **Build DB** | 使用 `makeblastdb` 构建本地 BLAST 数据库，或选择 NCBI 远程搜索模式 |
| 3 | **BLAST Search** | 运行 `blastp` 搜索，支持多 query 合并策略（best-evalue / union），过滤命中结果，**NCBI 分类注释**（查询 NCBI Entrez 自动填充 kingdom/phylum/class/species） |
| 4 | **Alignment** | 使用 MAFFT 进行多序列比对，支持列范围预览 |
| 5 | **Scoring** | 基于比对位点的自定义打分规则，支持 JSON 导入/导出，阈值过滤 |
| 6 | **Clustering** | CD-HIT 聚类（默认 85% identity），去冗余 |
| 7 | **Similarity** | 全序列 pairwise 相似性计算（global/local alignment），进度条实时显示 |
| 8 | **Network Push** | 按相似性阈值推送网络到 Cytoscape 桌面端（CyREST），自动应用 phylum 着色样式 |
| 9 | **候选推荐** | 基于多维加权评分的候选序列自动推荐，支持 FASTA 导出和 Cytoscape 高亮 |

### HMMER 模块（基于隐马尔可夫模型搜索）

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | **Reference** | 从 UniProt 获取参考序列 |
| 2 | **HMM Build** | MAFFT 多序列比对 → `hmmbuild` 构建 HMM profile |
| 3 | **EBI Search** | 提交 HMMER 搜索至 EBI API，下载命中结果，**UniProt 注释**（批量查询 UniProt 获取 taxonomy + 序列长度） |
| 4 | **Alignment** | MAFFT 比对参考 + 候选序列，可视化预览 |
| 5 | **Scoring** | 自定义位点打分规则，支持 JSON 导入/导出 |
| 6 | **Clustering** | CD-HIT 聚类去冗余 |
| 7 | **Similarity** | Pairwise 相似性计算 |
| 8 | **Network Push** | 推送到 Cytoscape |
| 9 | **候选推荐** | 基于多维加权评分的候选序列自动推荐 |

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

Vite 开发服务器运行在 `http://0.0.0.0:3000`，自动代理 `/api` 到 `http://127.0.0.1:8787`。

**可选环境变量：**

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_PORT` | `8787` | 后端端口 |
| `PIPELINE_ROOT` | 工作区根目录 | Pipeline 根目录 |
| `PIPELINE_TASKS_ROOT` | `{PIPELINE_ROOT}/tasks` | 任务数据目录 |
| `PIPELINE_PYTHON` | `python3` | Python 解释器路径 |
| `API_KEY` | _(空)_ | API 认证密钥（生产环境建议设置） |

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
- `POST /api/alignment/run` — MAFFT 比对
- `POST /api/scoring/run` — 打分
- `POST /api/clustering/run` — CD-HIT 聚类
- `POST /api/network/compute-similarity` — 相似性计算
- `POST /api/network/push-cytoscape` — 推送到 Cytoscape
- `POST /api/network/predict-metrics` — 性质预测（kcat/solubility/Tm），结果缓存到 `predicted_metrics.csv`
- `POST /api/network/recommend-candidates` — 候选序列推荐（六维加权，含 Strategy 1 预测评分）
- `POST /api/network/export-recommended-fasta` — 导出推荐候选 FASTA
- `POST /api/network/highlight-cytoscape` — 在 Cytoscape 中高亮选中节点

## 8. 候选推荐系统

### Strategy 1: Property Prediction Score（性质预测评分）

在 Recommendation 页面新增「Strategy 1」卡片，可一键对网络中所有候选序列运行以下三个预测：

| 预测指标 | 说明 | 评分逻辑 |
|----------|------|----------|
| **kcat** | 催化速率常数 | 值越大越好（min-max 归一化） |
| **Solubility** | 溶解度 (%) | 值越大越好（min-max 归一化） |
| **Tm** | 熔解温度 (°C) | 越接近「目标温度」越好（高斯衰减） |

三个指标通过**可拖拽权重条**（默认各 1/3）实时调整占比，并计算加权综合评分（`predictedScore`）。

**参数配置：**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| kcat 权重 | 33% | kcat 预测值占比 |
| Solubility 权重 | 33% | 溶解度预测值占比 |
| Tm 权重 | 33% | 熔解温度占比 |
| Tm 目标温度 | 60°C | 序列 Tm 越接近此值得分越高 |

**结果缓存**：预测结果缓存到任务目录下的 `predicted_metrics.csv`，重复打开不会重新调用 API；"Recompute All" 按钮可强制重新计算。

> **后端说明**：当前预测 API 使用确定性哈希伪随机数模拟（同一序列每次结果一致），`server.mjs` 中的 `predictKcatMock` / `predictSolubilityMock` / `predictTmMock` 三个函数带有 `TODO` 注释，等真实 API 就绪后只需替换函数体即可。

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

### 附加功能

- **FASTA 导出**：将推荐候选序列导出为 FASTA 格式文件下载
- **Cytoscape 高亮**：一键在 Cytoscape 桌面端选中/高亮推荐的候选节点（通过 CyREST Commands API）
- **状态持久化**：推荐结果和所有参数（包括 Strategy 1 的 kcat/solubility/Tm 权重、Tm 目标温度、网络连通性阈值等）在页面刷新后自动恢复

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
│   └── api.ts               # 前端 API 客户端
├── index.html
├── package.json
├── start.sh                 # 一键启动脚本
├── stop.sh                  # 停止脚本
├── vite.config.ts
└── tailwind.config.js
```
