# 自动代码解释

在 VS Code 中选中一行或一段代码，停留约 500 毫秒后，扩展在侧边栏逐步显示中文解释和对应的文件行号。支持鼠标拖选和键盘选区。

## 安装和使用

1. 使用 VS Code 1.100 或更新版本。从 [GitHub Releases](https://github.com/aminasada18-byte/auto-code-explain/releases/tag/v0.2.0) 下载 `auto-code-explain-0.2.0.vsix`，再在扩展视图右上角的 `…` 菜单中选择 **从 VSIX 安装**。
2. 在 VS Code 的聊天面板登录 GitHub Copilot。然后点击活动栏中的「代码解释」或状态栏中的「解释已暂停」，启用自动解释并完成首次授权。
3. 在编辑器中选中代码。解释需要重试时，可点击侧边栏中的「重新解释」。用侧边栏或状态栏的开关暂停功能，重启 VS Code 后会恢复上次的开关状态。

解释会参考当前文件及能定位的相关项目源码，说明选区在实际调用流程中的作用。「显示变量含义」默认开启，会先列出选区中的变量、参数、别名与关键名称，然后再解释代码。关掉后会直接解释代码。切换时会重新解释当前选区，设置会保存。

启用新版时需要确认项目上下文的发送范围。生成解释时，Copilot 会收到选区、当前文件的相关内容，以及少量能定位的相关文件片段。空白选区和多光标选区会跳过，每次选区最多 12,000 字符。

## 本地开发

```powershell
pnpm install
pnpm build
```

用 VS Code 打开此目录后，按 `F5` 启动扩展开发宿主。在新窗口中打开任意源代码文件，再按上面的使用步骤试用。

重新打包时运行以下命令。

```powershell
pnpm dlx --package=@vscode/vsce --package=npm vsce package --no-dependencies --allow-missing-repository --skip-license
```
