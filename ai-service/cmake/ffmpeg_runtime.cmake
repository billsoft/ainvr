# Copyright AINVR. Select the pinned media ABI instead of the system FFmpeg.
set(AINVR_FFMPEG_ROOT "/opt/ainvr/ffmpeg-8.1.2" CACHE PATH "AINVR FFmpeg 8.1.2 development runtime")
if(NOT EXISTS "${AINVR_FFMPEG_ROOT}/lib/pkgconfig/libavformat.pc"
   OR NOT EXISTS "${AINVR_FFMPEG_ROOT}/include/libavutil/ffversion.h")
  message(FATAL_ERROR "Install the pinned FFmpeg 8.1.2 headers and libraries with deploy-package/build-ffmpeg-s100p.sh")
endif()
file(READ "${AINVR_FFMPEG_ROOT}/include/libavutil/ffversion.h" _ainvr_ffversion)
if(NOT _ainvr_ffversion MATCHES "FFMPEG_VERSION[ \t]+\"8\\.1\\.2\"")
  message(FATAL_ERROR "AINVR_FFMPEG_ROOT must contain FFmpeg 8.1.2")
endif()
set(_ainvr_saved_pkg_path "$ENV{PKG_CONFIG_PATH}")
set(ENV{PKG_CONFIG_PATH} "${AINVR_FFMPEG_ROOT}/lib/pkgconfig:${_ainvr_saved_pkg_path}")
# Version constraints also invalidate the previous unconstrained pkg-config cache.
pkg_check_modules(AVFORMAT REQUIRED IMPORTED_TARGET
  libavformat=62.12.102 libavcodec=62.28.102 libavutil=60.26.102)
set(ENV{PKG_CONFIG_PATH} "${_ainvr_saved_pkg_path}")
file(REAL_PATH "${AINVR_FFMPEG_ROOT}" _ainvr_ffmpeg_root)
foreach(_ainvr_media_name avformat avcodec avutil)
  find_library(AINVR_FFMPEG_${_ainvr_media_name} NAMES ${_ainvr_media_name}
    PATHS "${AINVR_FFMPEG_ROOT}/lib" REQUIRED NO_DEFAULT_PATH)
  file(REAL_PATH "${AINVR_FFMPEG_${_ainvr_media_name}}" _ainvr_media_library)
  cmake_path(IS_PREFIX _ainvr_ffmpeg_root "${_ainvr_media_library}" NORMALIZE _ainvr_from_prefix)
  if(NOT _ainvr_from_prefix OR NOT "${AINVR_FFMPEG_${_ainvr_media_name}}" IN_LIST AVFORMAT_LINK_LIBRARIES)
    message(FATAL_ERROR "pkg-config selected a different ${_ainvr_media_name} runtime")
  endif()
endforeach()
# Hide the embedded ABI from dynamically loaded GStreamer plugins. A plugin that
# uses system FFmpeg must bind its own ABI instead of symbols from these archives.
target_link_options(PkgConfig::AVFORMAT INTERFACE
  "LINKER:--exclude-libs,libavformat.a:libavcodec.a:libavutil.a")
message(STATUS "AINVR pinned FFmpeg: ${_ainvr_ffmpeg_root}; libavformat ${AVFORMAT_libavformat_VERSION}")
