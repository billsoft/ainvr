cmake_minimum_required(VERSION 3.16)
project(ainvr_bytetrack_reference LANGUAGES CXX)
enable_testing()
find_package(OpenCV REQUIRED COMPONENTS core)
find_package(Eigen3 REQUIRED)
set(UPSTREAM ${CMAKE_CURRENT_SOURCE_DIR}/../../ai-service/third_party/bytetrack)
add_library(bytetrack_reference STATIC
  ${UPSTREAM}/src/BYTETracker.cpp ${UPSTREAM}/src/STrack.cpp
  ${UPSTREAM}/src/kalmanFilter.cpp ${UPSTREAM}/src/lapjv.cpp ${UPSTREAM}/src/utils.cpp)
target_include_directories(bytetrack_reference PUBLIC ${UPSTREAM}/include ${OpenCV_INCLUDE_DIRS})
target_link_libraries(bytetrack_reference PUBLIC Eigen3::Eigen ${OpenCV_LIBS})
target_compile_features(bytetrack_reference PUBLIC cxx_std_17)
add_executable(bytetrack_reference_test ../ai_port/bytetrack_reference_test.cpp)
target_compile_options(bytetrack_reference_test PRIVATE -UNDEBUG)
target_link_libraries(bytetrack_reference_test PRIVATE bytetrack_reference)
add_test(NAME bytetrack_reference COMMAND bytetrack_reference_test)
set_tests_properties(bytetrack_reference PROPERTIES TIMEOUT 30)

set(SERVICE ${CMAKE_CURRENT_SOURCE_DIR}/../../ai-service/third_party/bytetrack_service)
add_library(bytetrack_service STATIC
 ${SERVICE}/src/BYTETracker.cpp ${SERVICE}/src/STrack.cpp
 ${SERVICE}/src/kalmanFilter.cpp ${SERVICE}/src/lapjv.cpp ${SERVICE}/src/utils.cpp)
target_include_directories(bytetrack_service PUBLIC ${SERVICE}/include ${OpenCV_INCLUDE_DIRS})
target_link_libraries(bytetrack_service PUBLIC Eigen3::Eigen ${OpenCV_LIBS})
target_compile_features(bytetrack_service PUBLIC cxx_std_17)
add_executable(bytetrack_service_test ../ai_port/bytetrack_reference_test.cpp)
target_compile_options(bytetrack_service_test PRIVATE -UNDEBUG)
target_link_libraries(bytetrack_service_test PRIVATE bytetrack_service)
add_test(NAME bytetrack_service COMMAND bytetrack_service_test)
set_tests_properties(bytetrack_service PROPERTIES TIMEOUT 30)

add_executable(bytetrack_time_test ../ai_port/bytetrack_time_test.cpp)
target_compile_options(bytetrack_time_test PRIVATE -UNDEBUG)
target_link_libraries(bytetrack_time_test PRIVATE bytetrack_service)
add_test(NAME bytetrack_source_time COMMAND bytetrack_time_test)
set_tests_properties(bytetrack_source_time PROPERTIES TIMEOUT 30)

add_executable(bytetrack_adapter_test ../ai_port/bytetrack_adapter_test.cpp)
target_compile_options(bytetrack_adapter_test PRIVATE -UNDEBUG)
target_link_libraries(bytetrack_adapter_test PRIVATE bytetrack_service)
add_test(NAME bytetrack_adapter COMMAND bytetrack_adapter_test)
set_tests_properties(bytetrack_adapter PROPERTIES TIMEOUT 30)

add_executable(bytetrack_rules_test ../ai_port/bytetrack_rules_test.cpp)
target_compile_options(bytetrack_rules_test PRIVATE -UNDEBUG)
target_link_libraries(bytetrack_rules_test PRIVATE bytetrack_service)
add_test(NAME bytetrack_rules COMMAND bytetrack_rules_test)
set_tests_properties(bytetrack_rules PROPERTIES TIMEOUT 30)

find_package(nlohmann_json REQUIRED)
add_executable(analytics_frame_integration ../ai_port/analytics_frame_test.cpp
 ../../ai-service/src/output/result.cpp ../../ai-service/src/stream/sei.cpp
 ../../ai-service/src/stream/video_codec.cpp)
target_compile_options(analytics_frame_integration PRIVATE -UNDEBUG)
target_link_libraries(analytics_frame_integration PRIVATE bytetrack_service nlohmann_json::nlohmann_json)
add_test(NAME analytics_frame_integration COMMAND analytics_frame_integration)
set_tests_properties(analytics_frame_integration PROPERTIES TIMEOUT 30)

# Phase-1 gate:tracking runs while rules/events/review/notification stay inert.
add_executable(analytics_phase_gate ../ai_port/analytics_phase_test.cpp
 ../../ai-service/src/output/result.cpp ../../ai-service/src/stream/sei.cpp
 ../../ai-service/src/stream/video_codec.cpp)
target_compile_options(analytics_phase_gate PRIVATE -UNDEBUG)
target_link_libraries(analytics_phase_gate PRIVATE bytetrack_service nlohmann_json::nlohmann_json)
add_test(NAME analytics_phase_gate COMMAND analytics_phase_gate)
set_tests_properties(analytics_phase_gate PROPERTIES TIMEOUT 30)

# Lost-track recovery after missed detections at low frame rates.
add_executable(bytetrack_recovery ../ai_port/bytetrack_recovery_test.cpp)
target_compile_options(bytetrack_recovery PRIVATE -UNDEBUG)
target_link_libraries(bytetrack_recovery PRIVATE bytetrack_service)
add_test(NAME bytetrack_recovery COMMAND bytetrack_recovery)
set_tests_properties(bytetrack_recovery PROPERTIES TIMEOUT 30)

# Offline tracking replay of recorded detections (no BPU) for A/B regression.
add_executable(tracking_replay ../ai_port/tracking_replay.cpp
 ../../ai-service/src/output/result.cpp ../../ai-service/src/stream/sei.cpp
 ../../ai-service/src/stream/video_codec.cpp)
target_link_libraries(tracking_replay PRIVATE bytetrack_service nlohmann_json::nlohmann_json)

# Short-loss coasting:display-only predicted boxes, never detections, last in SEI.
add_executable(analytics_coast ../ai_port/analytics_coast_test.cpp
 ../../ai-service/src/output/result.cpp ../../ai-service/src/stream/sei.cpp
 ../../ai-service/src/stream/video_codec.cpp)
target_compile_options(analytics_coast PRIVATE -UNDEBUG)
target_link_libraries(analytics_coast PRIVATE bytetrack_service nlohmann_json::nlohmann_json)
add_test(NAME analytics_coast COMMAND analytics_coast)
set_tests_properties(analytics_coast PROPERTIES TIMEOUT 30)
