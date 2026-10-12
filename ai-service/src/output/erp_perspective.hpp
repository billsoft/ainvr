// ERP(等距柱状全景图)-> 透视视角截图变换 —— 对应 Python
// output/erp_perspective.py。全景相机通道的截图归档跟普通相机不一样:
// 直接裁矩形框会严重变形,这里把检测框还原成"如果有个虚拟相机对准这个
// 方向拍出来的正常透视画面"。详见 docs/v1_parity_design.md §3.4——反直觉
// 的关键细节:降采样滤镜必须用 INTER_CUBIC,不能用"教科书正确"的
// INTER_AREA(会把超采样找回的细节又滤掉)。
#pragma once

#include <array>
#include <cstdint>
#include <list>
#include <map>
#include <mutex>
#include <optional>
#include <tuple>

#include <opencv2/core.hpp>

namespace ai_service::output {

constexpr double kMaxFovDeg = 170.0;
constexpr double kMinFovDeg = 1.0;
constexpr int kSafetyMinOutputPx = 16;

// 由检测框换算出的取景参数——中心点 + 动态 FOV + 建议输出画布大小。
struct ErpView {
  double cx = 0.0, cy = 0.0;
  double fov_h_deg = 0.0;
  int w_out = 0, h_out = 0;
};

// 检测框(左上角+宽高,ERP 像素坐标系)-> 取景参数。bbox 退化(宽高<=0)
// 时返回 nullopt,调用方应跳过这个检测框。square=true(由 adapter 的
// SquareSnapshotCrop() 契约声明的通道):取景强制正方形。
std::optional<ErpView> BboxToErpView(const std::array<double, 4>& bbox, double padding_ratio,
                                      int erp_w, int erp_h, int max_dimension,
                                      int samples_per_edge = 9, bool square = false);

// 按 factor 等比放大/缩小取景画布的采样密度(用于超采样)。
ErpView ScaleErpView(const ErpView& view, double factor);

// 算出 cv::remap 用的 (map_x, map_y)。
std::pair<cv::Mat, cv::Mat> BuildErpMap(int erp_w, int erp_h, double cx, double cy,
                                         double fov_h_deg, int w_out, int h_out);

// 按 build_erp_map 算出的映射表对 ERP 源图采样(INTER_CUBIC + BORDER_REPLICATE)。
cv::Mat SampleErpPerspective(const cv::Mat& erp_img, const cv::Mat& map_x, const cv::Mat& map_y);

// 按 (yaw 桶, pitch 桶, fov 桶, w_out, h_out) 量化缓存映射表。LRU 淘汰,
// 条数上限 max_entries,字节上限 max_bytes(大截图一条可达数 MB,只按条数封顶
// 会占到 GB 级;最新一条总保留)。线程安全(内部加锁,SnapshotStore 的写入线程独占使用,
// 加锁只是为了在测试/未来多线程场景下也安全)。
class ErpMapCache {
 public:
  explicit ErpMapCache(double bucket_deg = 3.0, size_t max_entries = 256,
                       size_t max_bytes = size_t(64) << 20);

  std::pair<cv::Mat, cv::Mat> GetOrBuild(int erp_w, int erp_h, const ErpView& view);
  size_t Size() const;

 private:
  // (erp_w, erp_h, yaw桶, pitch桶, fov桶, w_out, h_out)。std::tuple 自带
  // 字典序 operator<,直接当 std::map 的 key,不需要自定义 hasher——量级
  // 最多 max_entries 条(默认 256),红黑树的 O(log n) 完全够用。
  using Key = std::tuple<int, int, int64_t, int64_t, int64_t, int, int>;
  Key MakeKey(int erp_w, int erp_h, const ErpView& view) const;

  double bucket_deg_;
  size_t max_entries_;
  size_t max_bytes_;
  size_t bytes_ = 0;
  mutable std::mutex mutex_;
  std::list<std::pair<Key, std::pair<cv::Mat, cv::Mat>>> lru_;
  std::map<Key, decltype(lru_)::iterator> index_;
};

}  // namespace ai_service::output
