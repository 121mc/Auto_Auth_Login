# NJU Auto Auth Login

南京大学统一身份认证自动登录 Chrome 扩展。后台定时检测会话状态，过期时自动重新登录，内置本地验证码识别。

## 功能

- 后台定时检测登录状态（3~5 分钟随机间隔）
- 会话过期时自动打开登录页、填充凭据、识别验证码并提交
- 基于 ONNX Runtime Web + ddddocr 模型的离线验证码识别，不依赖外部服务
- 用户主动打开登录页时也会自动填充登录
- Popup 面板查看状态和日志

## 项目结构

```
├── manifest.json                 扩展清单 (Manifest V3)
├── background/
│   └── background.js             Service Worker，定时检测与消息路由
├── content/
│   └── content.js                Content Script，页面填充与表单提交
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js                  弹出面板
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js              Offscreen Document，运行 ONNX 推理
├── lib/
│   ├── ort.wasm.min.js           ONNX Runtime Web (WASM)
│   └── ort-wasm-simd-threaded.wasm
├── models/
│   ├── common_old.onnx           ddddocr OCR 模型
│   └── charset_old.json          字符集
└── icons/
    └── icon128.png
```

## 工作流程

1. Background Service Worker 通过 `chrome.alarms` 定时触发检查
2. `fetch` 访问登录页，根据响应类型判断会话是否有效（重定向 = 有效，返回登录页 = 过期）
3. 会话过期时，后台打开登录页标签页
4. Content Script 注入页面，填写用户名和密码
5. 获取验证码图片，发送给 Offscreen Document
6. Offscreen Document 用 ONNX Runtime 运行模型推理，CTC 解码得到识别结果
7. 回填验证码，调用页面原生加密函数处理密码后提交表单
8. 登录成功后关闭后台标签页

## 安装

### 方法一：加载解压后的扩展（推荐）

1. 克隆仓库

   ```bash
   git clone https://github.com/your-username/Auto_Auth_Login.git
   ```

2. 打开 `chrome://extensions/`（Edge 浏览器为 `edge://extensions/`），开启开发者模式

3. 点击「加载已解压的扩展程序」，选择项目目录

### 方法二：使用 .crx 文件安装

1. 打开浏览器的扩展管理页面（如 `chrome://extensions/` 或 `edge://extensions/`）
2. 开启页面上的“开发者模式”
3. 将打包好的 `.crx` 文件直接**拖拽**到该页面中
4. 在弹出的提示框中点击“添加扩展程序”即可完成安装

> **注意**：受限于 Chrome 的安全策略，通过拖拽安装的非官方 `.crx` 扩展有可能会被浏览器自动禁用。如果遇到这种情况，请改用**方法一**，或使用 Edge 浏览器。

## 使用

1. 点击工具栏扩展图标，输入学号/工号和密码
2. 开启「启用自动登录」
3. 点击「保存设置」

保存后扩展开始后台运行。也可以点击「立即检查」手动触发一次检测。

## 权限

| 权限 | 用途 |
|---|---|
| `storage` | 存储凭据、状态和日志 |
| `alarms` | 定时检查 |
| `offscreen` | 创建 Offscreen Document 运行 ONNX 推理 |
| `tabs` | 后台打开登录页 |
| `host_permissions: authserver.nju.edu.cn` | 访问认证服务器 |

## 安全说明

- 凭据存储在 `chrome.storage.local`，不会发送到任何第三方服务器
- 验证码识别完全在本地完成

## 注意

- 仅适用于南京大学统一身份认证系统（`authserver.nju.edu.cn`）
- 验证码识别偶尔可能失败，扩展会在下次检查时重试
- 需要保持 Chrome 在后台运行
