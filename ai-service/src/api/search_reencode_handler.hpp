// Shared production adapter: authenticated HTTP input -> existing affine owner.
// RegisterRoutes owns raw-body/hash/auth checks. A license oracle is mandatory;
// production supplies LicenseClient, never the manual probe's software oracle.
#pragma once
#include "control_server.hpp"
#include "output/search_hardware_owner.hpp"
namespace ai_service::api {
inline SearchReencodeImage MakeSearchReencodeHandler(
    std::shared_ptr<output::SearchHardwareOwner> owner,
    std::function<bool()> authorized,std::function<bool()> current={}) {
  if(!owner||!authorized)throw std::invalid_argument("search_reencode_authority_required");
  return [owner=std::move(owner),authorized=std::move(authorized),current=std::move(current)]
      (const nlohmann::json& input,const std::string& jpeg)->nlohmann::json {
    if(!authorized())throw ApiError(403,"license_required","当前授权不允许图像重编码");
    const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    const auto expires=input.at("expires_ms").get<int64_t>();
    if(expires<=now||expires-now>30000)throw ApiError(410,"search_reencode_expired","重编码授权已过期");
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(expires-now);
    const auto& raw_target=input.at("target");
    const ainvr::search::RuntimeModelPin target{raw_target.at("package_id").get<std::string>(),
      raw_target.at("package_sha256").get<std::string>(),raw_target.at("model_version").get<std::string>()};
    if(target.package_id!="siglip2-base-full-int8")
      throw ApiError(503,"search_reencode_model_unavailable","该模型尚未提供经验证的历史图像编码器");
    const auto valid=[&]{return (!current||current())&&authorized()&&std::chrono::steady_clock::now()<deadline;};
    auto result=owner->Reencode(target,std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(jpeg.data()),jpeg.size()),deadline,valid);
    using Status=output::SearchReencodeResult::Status;
    if(result.status==Status::Busy)throw ApiError(429,"search_reencode_busy","图像硬件暂忙，请稍后重试");
    if(result.status==Status::Stale||!valid())throw ApiError(410,"search_reencode_expired","重编码授权已过期");
    if(result.status==Status::Unsupported)throw ApiError(422,"search_reencode_unsupported_image","原图不支持硬件重编码");
    if(result.status!=Status::Ready)throw ApiError(503,"search_reencode_unavailable","硬件图像编码暂不可用");
    if(result.space.package_id!=target.package_id||result.space.model_version!=target.model_version)
      throw ApiError(409,"search_reencode_target_changed","目标模型已改变，请重新准备迁移");
    auto response=input;
    response["input_kind"]="retained-jpeg";
    response["preprocessing_version"]=output::kSearchReencodePreprocessing;
    response["image_width"]=result.image_width;response["image_height"]=result.image_height;
    response["dimensions"]=result.embedding.size();response["vector"]=std::move(result.embedding);
    return response;
  };
}
} // namespace ai_service::api
