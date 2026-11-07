# ai-tools

一些自己写的小工具，主要是浏览器扩展和自动化脚本。

| 工具 | 说明 |
| --- | --- |
| [feishu-doc-exporter](feishu-doc-exporter/) | 飞书云文档「图片 + 表格」批量勾选导出，打包成 ZIP（图片取原图，表格转 CSV） |

## feishu-doc-exporter

飞书文档正文里的图片是虚拟滚动 + blob 预览，页面上没法直接右键另存原图；表格也没法整块复制成规整的 CSV。这个扩展解决这两件事：

- 自动从上到下滚动整篇文档，收集所有图片块和表格块（虚拟滚动只能边滚边收，跳转会丢块）
- 图片走 `/space/api/box/stream/download/all/<image-token>/` 拿**原图**，不是页面上那张压缩预览
- 表格解析 `rowspan/colspan` 还原成二维表格，导出带 BOM 的 CSV
- 面板里逐张勾选，一次性打包下载

实测数据（一份 3161 个块的文档）：128 张图 + 3 个表，扫描约 90 秒，原图导出尺寸 4277×2625，表格 CSV 多行多列完整。

### 安装

1. 下载本仓库（`Code` → `Download ZIP`）或 `git clone`
2. 打开 `chrome://extensions/`（Edge：`edge://extensions/`），开启**开发者模式**
3. 「加载已解压的扩展程序」→ 选择 `feishu-doc-exporter/` 文件夹

### 使用

打开飞书文档 → 右下角「导出」按钮 → 扫描文档 → 勾选 → 导出选中。

导出结构：

```
<文档名>_<日期_时间>.zip
├── images/img_001_<blockId>.png   原图
├── tables/table_01.csv            UTF-8 BOM
└── index.md                       来源、时间、每张图尺寸与所属章节
```

### 已知限制

- 只导出正文里可见的图片和表格；「嵌入电子表格」块只识别不导出
- 200 张以上原图的文档 ZIP 会有几百 MB，建议分批
- 只读预览状态可用；需要权限的文档请先登录

更多细节见 [feishu-doc-exporter/README.md](feishu-doc-exporter/README.md)。

## License

MIT
