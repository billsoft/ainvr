# AINVR: compile mature archive business independently of hardware workers.
find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)
add_library(ainvr_reused_archive_business OBJECT
  src/output/snapshot_repository.cpp
  src/output/snapshot_pipeline.cpp)
target_include_directories(ainvr_reused_archive_business PUBLIC src ${OpenCV_INCLUDE_DIRS})
target_link_libraries(ainvr_reused_archive_business PUBLIC PkgConfig::MONGOC
  nlohmann_json::nlohmann_json Threads::Threads ${OpenCV_LIBS})
# CPU reference algorithms remain the acceptance baseline for S100P backends.
add_library(ainvr_erp_geometry_metadata
  src/output/erp_perspective.cpp)
target_compile_definitions(ainvr_erp_geometry_metadata PRIVATE AINVR_ERP_METADATA_ONLY=1)
target_include_directories(ainvr_erp_geometry_metadata PUBLIC src ${OpenCV_INCLUDE_DIRS})
target_link_libraries(ainvr_erp_geometry_metadata PUBLIC ${OpenCV_LIBS} Threads::Threads)
if(BUILD_TESTING)
  add_library(ainvr_reference_image_algorithms src/output/erp_perspective.cpp)
  target_include_directories(ainvr_reference_image_algorithms PUBLIC src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(ainvr_reference_image_algorithms PUBLIC ${OpenCV_LIBS} Threads::Threads)
  add_library(ainvr_exposure_cpu_reference src/output/exposure.cpp)
  target_include_directories(ainvr_exposure_cpu_reference PUBLIC src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(ainvr_exposure_cpu_reference PUBLIC ${OpenCV_LIBS})
  foreach(pair IN ITEMS "erp_perspective;ERP;erp" "exposure;EXPOSURE;exposure")
    list(GET pair 0 unit)
    list(GET pair 1 macro)
    list(GET pair 2 fixture)
    add_executable(reused_${unit}_test tests/unit/${unit}_test.cpp)
    target_compile_definitions(reused_${unit}_test PRIVATE
      ${macro}_FIXTURES_PATH="${CMAKE_CURRENT_SOURCE_DIR}/tests/unit/${fixture}_fixtures.json")
    target_link_libraries(reused_${unit}_test PRIVATE ainvr_reference_image_algorithms
      GTest::gtest_main nlohmann_json::nlohmann_json)
    if(unit STREQUAL "exposure")
      target_link_libraries(reused_${unit}_test PRIVATE ainvr_exposure_cpu_reference)
    endif()
    add_test(NAME reused_${unit} COMMAND reused_${unit}_test)
  endforeach()
endif()

add_library(ainvr_reused_snapshot_store
  $<TARGET_OBJECTS:ainvr_reused_archive_business>
  src/output/snapshot_store.cpp src/output/snapshot_processing.cpp src/output/snapshot_pending.cpp
  src/output/face_enhancer_backend.cpp src/output/snapshot_crop_gles.cpp)
target_link_libraries(ainvr_reused_snapshot_store PUBLIC ainvr_reused_archive_business
  ainvr_erp_geometry_metadata ainvr_config)
add_library(ainvr_crop_hardware src/platform/gles_crop.cpp)
target_include_directories(ainvr_crop_hardware PUBLIC src ${OpenCV_INCLUDE_DIRS})
target_link_libraries(ainvr_crop_hardware PUBLIC ${OpenCV_LIBS})
target_link_libraries(ainvr_reused_snapshot_store PUBLIC ainvr_crop_hardware)
if(AINVR_S100P)
  target_compile_definitions(ainvr_crop_hardware PRIVATE AINVR_CROP_GLES=1)
  target_link_libraries(ainvr_crop_hardware PUBLIC ainvr_gles)
endif()
add_library(ainvr_exposure_hardware src/output/exposure_gles.cpp)
target_include_directories(ainvr_exposure_hardware PUBLIC src ${OpenCV_INCLUDE_DIRS})
target_link_libraries(ainvr_exposure_hardware PUBLIC ${OpenCV_LIBS})
target_link_libraries(ainvr_reused_snapshot_store PUBLIC ainvr_exposure_hardware)
if(AINVR_S100P)
  target_compile_definitions(ainvr_exposure_hardware PRIVATE AINVR_EXPOSURE_GLES=1)
  target_link_libraries(ainvr_exposure_hardware PUBLIC ainvr_gles)
endif()
if(BUILD_TESTING)
  add_executable(reused_snapshot_store_test tests/unit/snapshot_store_test.cpp)
  target_compile_definitions(reused_snapshot_store_test PRIVATE
    SNAPSHOT_CROP_FIXTURES_PATH="${CMAKE_CURRENT_SOURCE_DIR}/tests/unit/snapshot_crop_fixtures.json"
    LOCAL_CONFIG_PATH="/nonexistent/ainvr-test-config.yaml")
  # Keep the original tiny-image business fixtures as explicit CPU test oracles.
  # Real hardware color/JPEG acceptance uses snapshot_jpu_test separately.
  add_library(ainvr_snapshot_jpeg_cpu_reference ../test/ai_port/snapshot_jpeg_cpu_reference.cpp)
  target_link_libraries(ainvr_snapshot_jpeg_cpu_reference PUBLIC ainvr_reused_archive_business)
  add_library(ainvr_reused_snapshot_store_reference
    $<TARGET_OBJECTS:ainvr_reused_archive_business>
    src/output/snapshot_store.cpp src/output/snapshot_processing.cpp src/output/snapshot_pending.cpp
    src/output/face_enhancer_backend.cpp src/output/snapshot_crop.cpp)
  target_link_libraries(ainvr_reused_snapshot_store_reference PUBLIC
    ainvr_reused_archive_business ainvr_reference_image_algorithms ainvr_config
    ainvr_snapshot_jpeg_cpu_reference ainvr_exposure_cpu_reference)
  target_compile_definitions(ainvr_reused_snapshot_store_reference PRIVATE AINVR_PENDING_PNG_TEST_ORACLE=1)
  target_link_libraries(reused_snapshot_store_test PRIVATE ainvr_reused_snapshot_store_reference GTest::gtest_main)
endif()

target_sources(ainvr_reused_snapshot_store PRIVATE src/output/snapshot_jpeg.cpp)
if(AINVR_S100P)
  target_compile_definitions(ainvr_reused_snapshot_store PRIVATE AINVR_ARCHIVE_JPU=1)
  target_link_libraries(ainvr_reused_snapshot_store PUBLIC ainvr_jpeg ainvr_gles)
endif()

if(BUILD_TESTING AND AINVR_S100P)
  add_executable(snapshot_hardware_archive_test ../test/ai_port/snapshot_hardware_archive_test.cpp)
  target_link_libraries(snapshot_hardware_archive_test PRIVATE ainvr_reused_snapshot_store GTest::gtest_main)
  add_test(NAME snapshot_hardware_archive COMMAND snapshot_hardware_archive_test)
  set_tests_properties(snapshot_hardware_archive PROPERTIES RUN_SERIAL TRUE TIMEOUT 240 LABELS hardware)
  add_library(ainvr_crop_quality_oracle src/output/snapshot_crop.cpp src/output/erp_perspective.cpp)
  target_compile_definitions(ainvr_crop_quality_oracle PRIVATE
    CropWithPadding=CropWithPaddingReference SnapshotCropper=SnapshotCropperReference
    ErpMapCache=ErpMapCacheReference BuildErpMap=BuildErpMapReference
    SampleErpPerspective=SampleErpPerspectiveReference
    BboxToErpView=BboxToErpViewReference ScaleErpView=ScaleErpViewReference)
  target_include_directories(ainvr_crop_quality_oracle PUBLIC src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(ainvr_crop_quality_oracle PUBLIC ainvr_reused_archive_business)
  add_executable(snapshot_crop_gles_test ../test/ai_port/snapshot_crop_gles_test.cpp)
  target_link_libraries(snapshot_crop_gles_test PRIVATE ainvr_reused_snapshot_store ainvr_crop_quality_oracle GTest::gtest_main)
  add_test(NAME snapshot_crop_gles COMMAND snapshot_crop_gles_test)
  set_tests_properties(snapshot_crop_gles PROPERTIES RUN_SERIAL TRUE TIMEOUT 180 LABELS hardware)
  add_library(ainvr_exposure_quality_oracle src/output/exposure.cpp)
  target_compile_definitions(ainvr_exposure_quality_oracle PRIVATE
    CorrectExposure=CorrectExposureReference CorrectExposureRgba=CorrectExposureRgbaReference)
  target_include_directories(ainvr_exposure_quality_oracle PUBLIC src ${OpenCV_INCLUDE_DIRS})
  target_link_libraries(ainvr_exposure_quality_oracle PUBLIC ${OpenCV_LIBS})
  add_executable(exposure_gles_test ../test/ai_port/exposure_gles_test.cpp)
  target_link_libraries(exposure_gles_test PRIVATE ainvr_reused_snapshot_store
    ainvr_exposure_quality_oracle GTest::gtest_main)
  add_test(NAME exposure_gles COMMAND exposure_gles_test)
  set_tests_properties(exposure_gles PROPERTIES RUN_SERIAL TRUE TIMEOUT 120 LABELS hardware)
  add_executable(snapshot_jpu_test ../test/ai_port/snapshot_jpu_test.cpp)
  target_link_libraries(snapshot_jpu_test PRIVATE ainvr_reused_snapshot_store GTest::gtest_main)
  add_test(NAME snapshot_jpu COMMAND snapshot_jpu_test)
  set_tests_properties(snapshot_jpu PROPERTIES RUN_SERIAL TRUE TIMEOUT 60 LABELS hardware)
  add_executable(snapshot_jpu_failure_test ../test/ai_port/snapshot_jpu_failure_test.cpp)
  target_link_libraries(snapshot_jpu_failure_test PRIVATE ainvr_reused_snapshot_store GTest::gtest_main)
  add_test(NAME snapshot_jpu_failure COMMAND snapshot_jpu_failure_test)
  set_tests_properties(snapshot_jpu_failure PROPERTIES RUN_SERIAL TRUE TIMEOUT 60 LABELS hardware)
endif()

# The original controller now depends on the managed-worker contract only.
add_library(ainvr_reused_controller OBJECT src/api/control_server.cpp)
target_link_libraries(ainvr_reused_controller PUBLIC ainvr_reused_snapshot_store)
target_sources(ainvr_reused_controller PRIVATE src/pipeline/managed_worker.cpp
  src/adapters/task_metadata.cpp)
add_executable(ainvr_s100p_control_service src/api/s100p_control_service.cpp)
target_link_libraries(ainvr_s100p_control_service PRIVATE ainvr_reused_controller)
set_target_properties(ainvr_s100p_control_service PROPERTIES BUILD_RPATH /usr/hobot/lib)
if(BUILD_TESTING)
  add_executable(reused_controller_output_test ../test/ai_port/reused_controller_output_test.cpp)
  target_link_libraries(reused_controller_output_test PRIVATE ainvr_reused_controller GTest::gtest_main)
  add_test(NAME reused_controller_output COMMAND reused_controller_output_test)
endif()
