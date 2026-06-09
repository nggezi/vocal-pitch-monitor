# 实时练唱音高监测

一个纯前端网页，用浏览器麦克风实时检测唱歌音高，显示音名、频率、与最近标准音的 cents 偏差和稳定性，并用钢琴窗记录最近一段时间的音高轨迹。

## 功能特点

- **实时音高检测**：使用 Web Audio API 采集麦克风音频，通过自相关算法实时分析音高
- **音高显示**：显示当前音名（如 C4、D#5）、频率（Hz）和与标准音的 cents 偏差
- **钢琴窗轨迹**：像 Auto-Tune 一样可视化最近 14 秒的音高变化轨迹
- **音域选择**：支持男低、男高、女低、女高、宽范围五种音域显示模式
- **稳定性分析**：显示当前音高的稳定性评估
- **音量监测**：实时显示麦克风输入音量
- **交互式钢琴**：点击钢琴窗中的琴键可听到对应音高的参考音
- **纯前端实现**：所有处理在浏览器本地完成，无需服务器，不上传任何录音数据

## 本地运行

由于浏览器麦克风权限通常要求安全上下文，建议用本地 HTTP 服务打开：

```powershell
# 使用 Python（推荐）
python -m http.server 3000

# 或使用 Node.js（如果已安装）
npx serve .
```

然后访问：

```text
http://localhost:3000
```

## 使用建议

- 使用 Chrome 或 Edge 浏览器（支持最佳）
- 先唱稳定长音，减少颤音和滑音
- 安静环境下检测更准
- ±10 cents 内通常已经很准，初练可以先追求 ±25 cents 内
- 如果浏览器提示麦克风权限，请允许访问

## 技术栈

- **HTML5**：页面结构
- **CSS3**：响应式样式设计
- **JavaScript**：核心逻辑
- **Web Audio API**：音频采集与分析
- **Canvas API**：钢琴窗音高轨迹绘制

## 部署

### Cloudflare Pages（推荐）

1. 将代码推送到 GitHub 仓库
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
3. 进入 Workers & Pages → Create application → Pages
4. 选择 Connect to Git，连接你的 GitHub 仓库
5. 构建配置保持默认（留空）
6. 点击 Save and Deploy
7. 部署完成后访问 `https://your-project-name.pages.dev`

### 本地部署

也可以直接在本地运行，无需任何构建步骤。

## 项目结构

```text
voice/
├── index.html      # 主页面
├── app.js          # 核心 JavaScript 逻辑
├── style.css       # 样式文件
└── README.md       # 项目说明文档
```

## 注意事项

- 麦克风检测会受硬件质量、环境噪声、音量和发声方式影响
- 适合作为练习参考，不建议作为专业调音工具
- 首次使用时浏览器会请求麦克风权限，请允许
- 在移动设备上可能需要手动启用麦克风权限

## 许可证

本项目采用 [GNU 通用公共许可证 v3.0](LICENSE) 发布。