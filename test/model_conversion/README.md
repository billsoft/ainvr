# AINVR 模型转换最终入口

主手册：[PC GPU 环境与四模型编译](../../docs/S100P-HBM-PC-GPU.md)。从这里开始，不按文件名中的 probe/v 数字猜最终版本。

- `final/approved-recipes.json`：六组件成功 BC、精度优化等级和哈希。
- `final/run_approved_recipe.py`：默认只打印，`--execute` 才编译；不自动部署。
- `final/SCRIPT-INDEX.md`：保留脚本用途及参数。
- `final/script-manifest.json`：整理后的源码身份。
- `final/cleanup-manifest.json`：移出活动目录的 13 个历史脚本及恢复位置。

首次新数据/新模型必须重新校准及独立验证；已有已验收 BC 可直接复编。原脚本保留最终数学修复，不重写已经验证的实现。大型权重、数据及 BC 仍在 SSD，不进入此源码目录。
