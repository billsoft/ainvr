// 通道错误原因(last_error / 启动失败原因)会显示在控制台网页上:不能暴露推理框架、
// 模型文件名等内部实现。命中内部特征的换成通用说法,完整原文由调用方写进服务日志。
// 不含内部特征、对用户可操作的原因(如输入尺寸不符、授权、超时)原样保留。
#pragma once

#include <string>

namespace ai_service::utils {

std::string UserFacingError(const std::string& raw);

}  // namespace ai_service::utils
