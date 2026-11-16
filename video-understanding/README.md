# 视频理解与问答

把 MP4 切成约 20 秒一段，用本地 Qwen3-VL 逐段分析画面。网页按时间展示结果，可以对整段视频或指定片段提问，并点击引用跳到对应时间。

## Windows 本地运行

准备 Python 3.12、Git 和 FFmpeg。确认在 PowerShell 运行 `ffmpeg -version` 有输出。

```powershell
py -3.12 -m venv .venv
$python = ".\.venv\Scripts\python.exe"
& $python -m pip install -r requirements.txt
& $python -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
& $python -m pip install -r requirements-model.txt
```

上例使用 NVIDIA GPU 的 CUDA 12.8 版 PyTorch。仅用 CPU 时，将 PyTorch 的 `--index-url` 换成 `https://download.pytorch.org/whl/cpu`，推理耗时和内存占用会更高。

下载模型，或把 `QWEN_MODEL_DIR` 设置为已经下载好的模型文件夹的绝对路径。

```powershell
& ".\.venv\Scripts\hf.exe" download Qwen/Qwen3-VL-2B-Instruct --local-dir models/Qwen3-VL-2B-Instruct
& $python -m uvicorn app:app --app-dir server --host 127.0.0.1 --port 8000
```

打开 [本机网页](http://127.0.0.1:8000/)。上传的视频和分析结果保存在本机的 `server/uploads/`。模型在第一次分析时加载。

## 修改前端

`server/index.html` 是预构建页面，可直接运行。要改页面、动效或 3D 星球，请编辑 `frontend/`。安装 Node.js 和 pnpm 11 后，在项目目录运行以下命令会重新生成 `server/index.html`。

```powershell
pnpm --dir frontend-build install --frozen-lockfile
node frontend-build/build.mjs
```

## 可选的分享网关

本机开发入口默认只监听回环地址。要通过 HTTPS 反向代理分享，先把同一个随机 ASCII 密码设置为后端和 Node 网关环境变量 `VIDEO_SHARE_PASSWORD`。不要将实际值添加到 Git。

- 后端用 `python -m uvicorn shared_site:app --app-dir server --host 127.0.0.1 --port 8010` 启动。
- 网关用 `node server/public-gateway.mjs` 启动，监听 `127.0.0.1:8011`。反向代理指向网关的 8011 端口。
- 网关用浏览器 Cookie 限制谁能读取上传任务。分享模式的单次上传限额为 80 MiB，部署时应按实际使用情况配置使用范围。

GitHub 保存源码。视频上传、FFmpeg 和 Qwen 推理由运行 Python 服务的电脑或服务器执行。

## 第三方组件

页面使用 React、Three.js、React Three Fiber、Drei、GSAP 和 React Bits。第三方内容适用其上游许可。React Bits 的许可保存在 `licenses/ReactBits-LICENSE.md`，GSAP 的许可见[官方条款](https://gsap.com/standard-license/)和构建产物内的版权注释。
