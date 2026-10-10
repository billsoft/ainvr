/* Compile this one object against the new official camera headers. The pipeline
 * object uses installed VIN/ISP headers matching the running kernel. Only the
 * address and opaque camera handle cross this ABI boundary; no struct is cast. */
#include "common_utils.h"
#define sc132gs_linear_1088x1280_raw10_30fps_2lane sc132gs_bridge_config
#include PROBE_NEW_SENSOR_SOURCE
#undef sc132gs_linear_1088x1280_raw10_30fps_2lane
int32_t sc132gs_current_camera_create(uint32_t addr,camera_handle_t*out){
  camera_config_t cfg=*sc132gs_bridge_config.camera_config;
  cfg.addr=addr;
  return hbn_camera_create(&cfg,out);
}
