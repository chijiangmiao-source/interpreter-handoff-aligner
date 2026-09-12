# 口译交接时间轴对齐工具（Interpreter Handoff Aligner）

一场多语发布会结束后，两名口译员各自记录了交接附近听到的事件。漏记、补记与
时间偏移使组长无法直接对照双方笔记。本工具接收两组 JSON 笔记，使用**动态规划**
求出**全局最优且唯一**的对齐时间轴，并在页面上逐行展示配对、两类空缺、单步
代价、累计代价与总代价，支持逐步复算。

- 后端：Python 3.12 · FastAPI · 纯标准库实现的 DP（无任何外部匹配库）
- 前端：TypeScript · React 18 · Vite
- 测试：pytest（算法/校验/API）· Vitest（前端逻辑与组件）· Playwright（真实前后端联调）
- 部署：Docker Compose（web + api + 一次性 `verify` 验收服务）

---

## 1. 输入格式与示例

页面左右两个文本框各接收一个 **JSON 数组**；请求体形如
`{"left": [...], "right": [...]}`。每项**仅含**两个字段：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `time` | 整数 | 毫秒时间戳；组内**严格递增、不可重复** |
| `text` | 非空字符串 | 听到的内容 |

单组最多 **200** 项。结构错误、超限、重复/非递增时间、多余字段都只会产生
**一次**明确失败，响应（与页面高亮）指向首个错误路径，如 `left[2].time`，
且原始输入原样保留。

### 输入示例

```json
{
  "left": [
    {"time": 0, "text": "各位媒体朋友下午好"},
    {"time": 4200, "text": "新产品将于下月上市"},
    {"time": 9000, "text": "感谢各位的提问"}
  ],
  "right": [
    {"time": 150, "text": "各位媒体朋友下午好"},
    {"time": 4100, "text": "新产品将于下月上市"},
    {"time": 12000, "text": "交接后的补充记录"}
  ]
}
```

### 输出示例（节选）

```json
{
  "steps": [
    {"action": "match", "left": {"time": 0, "text": "各位媒体朋友下午好"},
     "right": {"time": 150, "text": "各位媒体朋友下午好"}, "cost": 150, "cumulative_cost": 150},
    {"action": "match", "left": {"time": 4200, "text": "新产品将于下月上市"},
     "right": {"time": 4100, "text": "新产品将于下月上市"}, "cost": 100, "cumulative_cost": 250},
    {"action": "right_gap", "left": null,
     "right": {"time": 12000, "text": "交接后的补充记录"}, "cost": 2000, "cumulative_cost": 2250},
    {"action": "left_gap", "left": {"time": 9000, "text": "感谢各位的提问"},
     "right": null, "cost": 2000, "cumulative_cost": 4250}
  ],
  "total_cost": 4250,
  "counts": {"match": 2, "left_gap": 1, "right_gap": 1},
  "costs": {"gap": 2000, "mismatch_penalty": 3000}
}
```

三种动作：

- `match`：左右各一项配对；
- `left_gap`：左侧有记录、右侧留空（右侧漏记）；
- `right_gap`：右侧有记录、左侧留空（左侧漏记）。

---

## 2. 代价规则与唯一性

对 `(m+1) × (n+1)` 的 DP 矩阵求最短路：

| 动作 | 单步代价 |
| --- | --- |
| 配对，`text` **相同** | `|timeL − timeR|` |
| 配对，`text` **不同** | `|timeL − timeR| + 3000` |
| 任一侧单项留空 | `2000` |

**平局裁决（保证时间轴唯一）**：总成本最小优先；成本相同时依次偏好

1. 配对（match）
2. 左侧留空（left gap）
3. 右侧留空（right gap）

动作仍无法区分时，取前驱坐标 `(i, j)` 字典序较小者。回溯得到的步骤按
笔记顺序排列，每一步带 `cumulative_cost`，页面的「上一步 / 下一步」按钮
可据此逐步复算到最终总代价。

---

## 3. 快速启动（Docker Compose，推荐）

需要 Docker（含 Compose v2）。

```bash
docker compose up --build
# 打开 http://localhost:8080
```

宿主端口可用环境变量覆盖（容器内部端口固定为 web 80、api 8000）：

```bash
WEB_PORT=9090 API_PORT=9000 docker compose up --build
# 页面 http://localhost:9090 ，API 文档 http://localhost:9000/docs
```

也可以复制 `.env.example` 为 `.env` 后修改 `WEB_PORT` / `API_PORT`，
Compose 会自动读取。

### 一次性验收服务 verify

`verify` 服务对**正在运行的容器栈**做真实联调验收（健康检查、web→api
同源代理、黄金样例、三类代价、平局顺序、单次失败契约、结果幂等唯一性），
通过后退出码为 0：

```bash
docker compose up --build -d            # 先把 web/api 跑起来
docker compose run --rm verify          # 一次性验收，结束自动删除容器
docker compose down
```

---

## 4. 本地开发启动

### 后端（需要 Python 3.12；本地用 3.11 亦可运行测试）

```bash
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
```

### 前端

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173 ，/api 自动代理到 127.0.0.1:8000
```

打开 http://localhost:5173 ，左右文本框已预填示例，点击「生成对齐」即可。

---

## 5. 测试

### pytest — 算法、校验与 API（40 个用例）

```bash
cd backend
python -m pytest
```

其中包含对所有小规模输入与朴素递归枚举的最优代价对拍，以及平局偏好
（配对 > 左留空 > 右留空）的专门用例。

### Vitest — 前端逻辑与组件（27 个用例）

```bash
cd frontend
npm test
```

覆盖与后端一致的客户端校验、带源码位置的 JSON 解析器、API 客户端、
错误路径高亮、输入保留与逐步复算交互。

### Playwright — 真实全栈联调（6 个用例）

先启动真实服务（生产构建 + FastAPI）：

```bash
cd backend && uvicorn app.main:app --port 8000 &
cd frontend && npm run build && npm run preview -- --port 4173 &
npx playwright test
```

用例在真实浏览器中验证：黄金时间轴的动作顺序与每步代价、逐步复算、
重复时间只报一次错且保留输入并高亮 `left[1].time`、超限（201 项）路径、
非法 JSON 的行列号定位、空数组零代价交接。也可设置
`E2E_AUTO_START=1 npx playwright test` 让 Playwright 自动拉起两端。

---

## 6. HTTP 接口

- `GET /health` → `200 {"status": "ok"}`
- `POST /api/align`

成功返回 `200` 与对齐结果；任何输入问题都返回**一个**错误对象：

```json
{"error": "left[1].time 为 1，未严格递增（上一项时间为 1）。", "path": "left[1].time"}
```

| 场景 | 状态码 | path 示例 |
| --- | --- | --- |
| 请求体不是合法 JSON | 400 | `""` |
| 根不是对象 / 缺少 left、right | 422 | `""` / `left` |
| 某侧不是数组 | 422 | `right` |
| 超过 200 项（指向越界首项） | 422 | `left[200]` |
| time 缺失/非整数/重复/非递增 | 422 | `left[2].time` |
| text 缺失/非字符串/为空 | 422 | `right[0].text` |
| 存在 time、text 之外的字段 | 422 | `left[0].who` |

校验顺序固定为先 `left` 后 `right`、自上而下，因此任何输入组合都只有
**首个**错误被报告。

---

## 7. 目录结构

```
.
├── backend/
│   ├── app/
│   │   ├── alignment.py      # DP 对齐（代价矩阵 + 平局裁决 + 回溯）
│   │   ├── validation.py     # 结构/数量/类型/递增校验，返回首个错误路径
│   │   └── main.py           # FastAPI、手工 JSON 解析、单次失败契约
│   ├── tests/                # pytest：算法对拍、校验、真实 ASGI API
│   ├── Dockerfile            # python:3.12-slim
│   └── requirements*.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx           # 页面：输入、错误定位、逐步复算
│   │   ├── ResultTimeline.tsx# 逐行动作/单步代价/累计/复算说明
│   │   ├── HighlightedTextarea.tsx
│   │   ├── jsonLocations.ts  # 带源码区间的 JSON 解析器（高亮首个错误）
│   │   ├── validation.ts     # 与后端一致的浏览器端校验
│   │   ├── api.ts            # /api/align 客户端
│   │   └── e2e/              # Playwright 真实联调用例
│   ├── Dockerfile            # 多阶段构建 + nginx 同源代理
│   └── nginx.conf
├── verify/
│   └── verify.py             # 仅用标准库的一次性联调验收脚本
├── docker-compose.yml        # api / web(WEB_PORT) / api(API_PORT) / verify
├── .env.example
└── .gitignore
```

## 8. 关于“无占位实现、无外部匹配库”

DP 矩阵、平局裁决与回溯全部为手写实现（`backend/app/alignment.py`，
约 100 行），未引入任何对齐/编辑距离/模糊匹配第三方库；前端的 JSON
源码定位解析器同样为手写递归下降。所有层（算法对拍、组件交互、浏览器
联调、容器内验收）均有自动化测试覆盖。
