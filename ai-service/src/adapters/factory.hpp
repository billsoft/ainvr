// 模型适配器工厂 —— 对应 Python adapters/factory.py。
//
// 与 Python 版的差异(移植设计文档 §4 明确记录的不移植清单,不是遗漏):
//   - yolo26_end2end / yolo26_traditional 走 ONNXRuntime,config.py 自己的
//     校验器已经确认这两条路径在本机只有 provider=cpu 能用、性能不足以
//     支撑生产,C++ 版没有实现对应的 adapter 类。CreateAdapter 收到这两
//     个 adapter 值时抛 std::invalid_argument,附带清楚的原因说明,不是
//     笼统的"未知 adapter"。
#pragma once

#include <memory>

#include "../config/config.hpp"
#include "base_adapter.hpp"

namespace ai_service::adapters {

// 根据配置创建模型适配器(不加载模型,调用方需再调 Load())。
// adapter 取值不在 AvailableAdapters() 范围内,或属于明确不移植/尚未接入
// 的范围,都抛 std::invalid_argument。
std::unique_ptr<BaseModelAdapter> CreateAdapter(const config::ModelConfig& model_config);

// 当前 C++ 版本已经可以创建的 adapter 名单(不含明确不移植/尚未接入的)。
std::vector<std::string> AvailableAdapters();

}  // namespace ai_service::adapters
