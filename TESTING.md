# 测试目录与执行约定

测试统一放在所属模块的 `tests/` 目录，不再与生产入口或 `src/` 混放。各模块独立管理依赖，因此不使用仓库根目录下的单一测试运行环境。

```text
engine/tests/          # 按原源码模块分组的 TypeScript 单元测试和 smoke 脚本
web/tests/             # Web 单元、协议、集成、浏览器测试及共享 fixture
web/tests/plugins/     # Web 插件测试
desktop/tests/scripts/ # 桌面构建与更新脚本的单元测试
desktop/tests/ui/      # 桌面 UI 单元和浏览器测试
desktop/tests/smoke/   # 桌面运行时安装与启动检查
desktop/tests/rust/    # Rust 单元测试；通过原模块引入，保留私有成员访问
docker_deploy/tests/   # 依赖 Docker 环境的部署验收脚本
```

## 基本规则

- 新增测试放入对应 `tests/`，测试辅助文件与 fixture 也应放在测试目录中。
- 测试引用生产代码使用相对路径；涉及资源、子进程和服务启动时，明确区分测试目录、模块根目录与仓库根目录。
- Engine 的生产构建仍输出 `engine/dist/`，不再将测试编译进生产包；测试源码使用 `tsx` 执行。
- 默认单元测试、浏览器测试、真实模型测试和部署 smoke 分开执行。不要为了让测试通过删除断言或默认调用付费模型。
- 移动测试后，同步更新 `package.json`、CI、聚合测试脚本和文档中的执行路径。

## 常用命令

在仓库根目录运行：

```sh
npm --prefix engine run typecheck
npm --prefix engine run build
npm --prefix engine test
npm --prefix web run build
npm --prefix web test
npm --prefix web run test:runtime
npm --prefix web run test:server
npm --prefix web run test:plugins
npm --prefix desktop test
npm --prefix desktop run check
```

各模块的完整测试入口和前置条件请参阅该模块的 `package.json`、README 或 `tests/README.md`。Web 测试如果选择本地核心模式，需先构建 Engine；测试和被测实现应使用同一个核心来源，不能混用 npm 包中的类与本地构建中的类。

## 环境相关测试

- 浏览器测试需要对应浏览器或 CDP/Playwright 环境，部分测试还需要先构建 Web。
- Desktop Rust 测试需要 Rust/Cargo、Tauri 及平台构建依赖；运行时 smoke 还需要预备运行时文件。
- Docker 部署测试需要已经配置好的执行容器和构建产物，详见 `docker_deploy/README.md`；不要在普通单元测试中自动运行。
- 真实模型 smoke 需要显式提供测试凭据，并可能产生费用。
